/**
 * 动态止盈止损计算模块
 */
const { proxyGet } = require('../utils/request');
const config = require('../config/config');
const { getSymbolPrecision } = require('../utils/cache');
const { log } = require('../utils/logger');
const { sendTelegramMessage } = require('../telegram/messenger');
const moment = require('moment-timezone');
const { createTakeProfitOrder, createStopLossOrder, } = require('../binance/trade')

// 动态止盈止损配置
const DYNAMIC_SL_RATIO = 0.8; // 止损ATR倍数
const DYNAMIC_TP_RATIO = 1.5;  // 止盈ATR倍数
const SUPPORT_RESISTANCE_BUFFER = 0.002; // 支撑阻力位缓冲(0.2%)

/**
 * 获取K线数据
 */

async function fetchKLines(symbol, interval, limit = 50) {
    const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await proxyGet(url);

    return response.data.map(k => ({
        openTime: k[0],                    // 开盘时间
        open: parseFloat(k[1]),            // 开盘价
        high: parseFloat(k[2]),            // 最高价
        low: parseFloat(k[3]),             // 最低价
        close: parseFloat(k[4]),           // 收盘价
        volume: parseFloat(k[5]),          // 成交量
        closeTime: k[6],                   // 收盘时间
        quoteVolume: parseFloat(k[7]),     // 成交额
        trades: k[8],                      // 成交笔数
        takerBuyBaseVolume: parseFloat(k[9]),  // 主动买入成交量
        takerBuyQuoteVolume: parseFloat(k[10]), // 主动买入成交额
        ignore: parseFloat(k[11])          // 忽略字段
    }));
}

/**
 * 主函数 - 为所有持仓设置动态止盈止损
 * @param {Array} positions - 当前持仓数组
 */
async function setupDynamicOrdersForAllPositions(positions = []) {
    if (!positions || positions.length === 0) {
        log('当前无持仓，跳过止盈止损设置');
        return;
    }

    for (const position of positions) {
        try {
            const { symbol, positionAmt, entryPrice } = position;
            const side = parseFloat(positionAmt) > 0 ? 'BUY' : 'SELL';

            // 1. 动态计算价格
            const { takeProfit, stopLoss } = await calculateDynamicPrices(
                symbol,
                side,
                parseFloat(entryPrice)
            );

            // 2. 设置止损单
            if (config.riskControl.enableStopLoss) {
                await createStopLossOrder(
                    symbol,
                    side === 'BUY' ? 'SELL' : 'BUY',
                    stopLoss
                );
                log(`🛑 ${symbol} 动态止损设置完成 | 触发价: ${stopLoss}`);
            }

            // 3. 设置止盈单（检查时间段）
            if (config.riskControl.enableTakeProfit && isInTradingTimeRange(config.takeProfitTimeRanges)) {
                await createTakeProfitOrder(
                    symbol,
                    side === 'BUY' ? 'SELL' : 'BUY',
                    takeProfit
                );
                log(`🎯 ${symbol} 动态止盈设置完成 | 触发价: ${takeProfit}`);
            }

            // 发送通知
            const priceInfo = `入场价: ${entryPrice} | 止损: ${stopLoss} | 止盈: ${takeProfit}`;
            const profitRatio = ((takeProfit - entryPrice) / (entryPrice - stopLoss)).toFixed(2);
            sendTelegramMessage(
                `📊 ${symbol} 动态订单设置\n${priceInfo}\n盈亏比: ${profitRatio}:1`
            );
        } catch (error) {
            let errorMsg = error.message;
            if (error.response) {
                errorMsg += ` | 状态码: ${error.response.status}`;
                if (error.response.data) {
                    errorMsg += ` | 返回: ${JSON.stringify(error.response.data)}`;
                }
            }
            log(`❌ ${position.symbol} 动态订单设置失败: ${errorMsg}`);
            sendTelegramMessage(`⚠️ ${position.symbol} 动态订单设置失败: ${errorMsg}`);
        }

        // } catch (error) {
        //     log(`❌ ${position.symbol} 动态订单设置失败: ${error.message}`);
        //     sendTelegramMessage(`⚠️ ${position.symbol} 动态订单设置失败: ${error.message}`);
        // }
    }
}

/**
 * 动态计算止盈止损价格（核心逻辑）
 * @param {string} symbol 交易对
 * @param {string} side 方向(BUY/SELL)
 * @param {number} entryPrice 入场价格
 * @returns {Promise<{takeProfit: number, stopLoss: number}>}
 */
async function calculateDynamicPrices(symbol, side, entryPrice) {
    // 获取必要数据
    const [klines, atr, supportResistance] = await Promise.all([
        (async () => {
            const data = await fetchKLines(symbol, '15m', 51);
            return data.slice(0, -1);
        })(),
        calculateATR(symbol, 14), // 计算ATR(14)
        calculateSupportResistance(symbol) // 计算支撑阻力位
    ]);


    // 基础波动范围
    const dynamicRange = atr * 1.5;
    const lastClose = parseFloat(klines[klines.length - 1].close);
    const isUptrend = lastClose > parseFloat(klines[0].close);

    if (side === 'BUY') {
        // 做多场景 ======================
        const dynamicTakeProfit = isUptrend
            ? Math.min(
                entryPrice + dynamicRange * DYNAMIC_TP_RATIO,
                supportResistance.resistance * (1 - SUPPORT_RESISTANCE_BUFFER)
            )
            : entryPrice + dynamicRange * (DYNAMIC_TP_RATIO * 0.8);

        const dynamicStopLoss = Math.max(
            entryPrice - dynamicRange * DYNAMIC_SL_RATIO,
            supportResistance.support * (1 + SUPPORT_RESISTANCE_BUFFER)
        );

        return {
            takeProfit: adjustPrecision(symbol, dynamicTakeProfit),
            stopLoss: adjustPrecision(symbol, dynamicStopLoss)
        };
    } else {
        // 做空场景 ======================
        const dynamicTakeProfit = isUptrend
            ? entryPrice - dynamicRange * (DYNAMIC_TP_RATIO * 0.8)
            : Math.max(
                entryPrice - dynamicRange * DYNAMIC_TP_RATIO,
                supportResistance.support * (1 + SUPPORT_RESISTANCE_BUFFER)
            );

        const dynamicStopLoss = Math.min(
            entryPrice + dynamicRange * DYNAMIC_SL_RATIO,
            supportResistance.resistance * (1 - SUPPORT_RESISTANCE_BUFFER)
        );

        return {
            takeProfit: adjustPrecision(symbol, dynamicTakeProfit),
            stopLoss: adjustPrecision(symbol, dynamicStopLoss)
        };
    }
}

/**
 * 计算ATR指标
 */
async function calculateATR(symbol, period) {
    const klinesRaw = await fetchKLines(symbol, '15m', period + 2);
    const klines = klinesRaw.slice(0, -1);

    let trSum = 0;

    for (let i = 1; i <= period; i++) {
        const high = parseFloat(klines[i].high);
        const low = parseFloat(klines[i].low);
        const prevClose = parseFloat(klines[i - 1].close);
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trSum += tr;
    }
    return trSum / period;
}

/**
 * 计算支撑阻力位
 */
async function calculateSupportResistance(symbol) {
    const klinesRaw = await fetchKLines(symbol, '15m', 51);
    const klines = klinesRaw.slice(0, -1);

    const prices = klines.flatMap(k => [
        parseFloat(k.high),
        parseFloat(k.low),
        parseFloat(k.close)
    ]).sort((a, b) => a - b);

    return {
        support: findPriceCluster(prices, 'lower'),
        resistance: findPriceCluster(prices, 'upper')
    };
}

/**
 * 寻找价格聚集区
 */
function findPriceCluster(prices, type) {
    const threshold = 0.005; // 0.5%价格区间
    let bestLevel = type === 'upper' ? Math.max(...prices) : Math.min(...prices);
    let maxCount = 0;

    for (const price of prices) {
        const count = prices.filter(p =>
            type === 'upper'
                ? p >= price && p <= price * (1 + threshold)
                : p <= price && p >= price * (1 - threshold)
        ).length;

        if (count > maxCount) {
            maxCount = count;
            bestLevel = price;
        }
    }
    return bestLevel;
}

/**
 * 精度调整
 */
function adjustPrecision(symbol, price) {
    const precision = getSymbolPrecision(symbol);
    return parseFloat(price.toFixed(precision.pricePrecision));
}

/**
 * 检查是否在允许设置止盈的时间段内
 */
function isInTradingTimeRange(timeRanges) {
    if (!timeRanges || timeRanges.length === 0) return true;

    const now = moment();
    return timeRanges.some(range => {
        const start = moment(range.start, 'HH:mm');
        const end = moment(range.end, 'HH:mm');
        return now.isBetween(start, end, null, '[]');
    });
}

module.exports = {
    setupDynamicOrdersForAllPositions,
    calculateDynamicPrices
};