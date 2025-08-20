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
const { getCurrentPrice } = require('../binance/market')
const { EMA, BollingerBands } = require('technicalindicators');

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
        let currentOrderType = null;
        let currentOrderParams = null;

        try {
            const { symbol, positionAmt, entryPrice } = position;
            const side = parseFloat(positionAmt) > 0 ? 'BUY' : 'SELL';
            const absPositionAmt = Math.abs(parseFloat(positionAmt));

            // 获取当前市场价格
            const currentPrice = await getCurrentPrice(symbol);

            // 1. 动态计算价格
            const { takeProfit, stopLoss } = await calculateDynamicPrices(
                symbol,
                side,
                parseFloat(entryPrice)
            );

            let validatedStopLoss = stopLoss;
            let validatedTakeProfit = takeProfit;

            // 验证价格合理性
            if (side === 'BUY') {
                // 多单验证
                if (validatedStopLoss >= currentPrice) {
                    validatedStopLoss = adjustPrecision(symbol, currentPrice * 0.995);
                    log(`⚠️ ${symbol} 多单止损价${stopLoss}高于当前价${currentPrice}，自动调整为${validatedStopLoss}`);
                }
                if (validatedTakeProfit <= currentPrice) {
                    validatedTakeProfit = adjustPrecision(symbol, currentPrice * 1.005);
                    log(`⚠️ ${symbol} 多单止盈价${takeProfit}低于当前价${currentPrice}，自动调整为${validatedTakeProfit}`);
                }
            } else {
                // 空单验证
                if (validatedStopLoss <= currentPrice) {
                    validatedStopLoss = adjustPrecision(symbol, currentPrice * 1.005);
                    log(`⚠️ ${symbol} 空单止损价${stopLoss}低于当前价${currentPrice}，自动调整为${validatedStopLoss}`);
                }
                if (validatedTakeProfit >= currentPrice) {
                    validatedTakeProfit = adjustPrecision(symbol, currentPrice * 0.995);
                    log(`⚠️ ${symbol} 空单止盈价${takeProfit}高于当前价${currentPrice}，自动调整为${validatedTakeProfit}`);
                }
            }

            // 2. 设置止损单
            if (config.riskControl.enableStopLoss) {
                currentOrderType = '止损单';
                currentOrderParams = {
                    symbol,
                    side: side === 'BUY' ? 'SELL' : 'BUY',
                    stopPrice: validatedStopLoss,
                    quantity: absPositionAmt,
                    type: 'STOP_LOSS_LIMIT',
                };

                await createStopLossOrder(
                    currentOrderParams.symbol,
                    currentOrderParams.side,
                    currentOrderParams.stopPrice,
                    currentOrderParams.quantity
                );
                log(`🛑 ${symbol} 动态止损设置完成 | 触发价: ${validatedStopLoss}`);
                currentOrderType = null;
                currentOrderParams = null;
            }

            // 3. 设置止盈单
            if (config.riskControl.enableTakeProfit && isInTradingTimeRange(config.takeProfitTimeRanges)) {
                currentOrderType = '止盈单';
                currentOrderParams = {
                    symbol,
                    side: side === 'BUY' ? 'SELL' : 'BUY',
                    stopPrice: validatedTakeProfit,
                    quantity: absPositionAmt,
                    type: 'TAKE_PROFIT_LIMIT',
                };

                await createTakeProfitOrder(
                    currentOrderParams.symbol,
                    currentOrderParams.side,
                    currentOrderParams.stopPrice,
                    currentOrderParams.quantity
                );
                log(`🎯 ${symbol} 动态止盈设置完成 | 触发价: ${validatedTakeProfit}`);
                currentOrderType = null;
                currentOrderParams = null;
            }

            // 发送通知
            const priceInfo = `入场价: ${entryPrice} | 止损: ${validatedStopLoss} | 止盈: ${validatedTakeProfit}`;
            const profitRatio = calculateProfitRatio(parseFloat(entryPrice), validatedTakeProfit, validatedStopLoss);
            sendTelegramMessage(
                `📊 ${symbol} 动态订单设置\n${priceInfo}\n盈亏比: ${profitRatio}`
            );
        } catch (error) {
            let errorMsg = error.message;
            if (error.response) {
                errorMsg += ` | 状态码: ${error.response.status}`;
                if (error.response.data) {
                    errorMsg += ` | 返回: ${JSON.stringify(error.response.data)}`;
                }
            }

            const errorSource = currentOrderType ? `[${currentOrderType}] ` : '';
            const orderParamsStr = currentOrderParams
                ? `\n失败订单参数: ${JSON.stringify(currentOrderParams, null, 2)}`
                : '';

            log(`❌ ${position.symbol} ${errorSource}动态订单设置失败: ${errorMsg}${orderParamsStr}`);
            sendTelegramMessage(
                `⚠️ ${position.symbol} ${errorSource}动态订单设置失败: ${errorMsg}${orderParamsStr}`
            );
        }
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
    try {
        // 获取必要数据
        const [klines, atr, supportResistance, currentPrice] = await Promise.all([
            (async () => {
                const data = await fetchKLines(symbol, '15m', 51);
                return data.slice(0, -1);
            })(),
            calculateATR(symbol, 14),
            calculateSupportResistance(symbol),
            getCurrentPrice(symbol)
        ]);

        // 常量定义
        const MIN_PROFIT_RATIO = 0.01; // 最小盈利比例1%
        const MIN_RISK_REWARD = 1.5; // 最小盈亏比1.5:1
        const SUPPORT_RESISTANCE_BUFFER = 0.005; // 支撑阻力位缓冲0.5%
        const ATR_MULTIPLIER_TP = 2.0; // 止盈ATR倍数
        const ATR_MULTIPLIER_SL = 1.2; // 止损ATR倍数

        const lastClose = parseFloat(klines[klines.length - 1].close);
        
        if (side === 'BUY') {
            // ============= 做多场景 =============
            let takeProfit = entryPrice + atr * ATR_MULTIPLIER_TP;
            let stopLoss = entryPrice - atr * ATR_MULTIPLIER_SL;

            // 应用支撑阻力约束
            if (supportResistance.resistance) {
                const resistanceLevel = supportResistance.resistance * (1 - SUPPORT_RESISTANCE_BUFFER);
                takeProfit = Math.min(takeProfit, resistanceLevel);
            }
            if (supportResistance.support) {
                const supportLevel = supportResistance.support * (1 + SUPPORT_RESISTANCE_BUFFER);
                stopLoss = Math.max(stopLoss, supportLevel);
            }

            // 确保价格合理性
            takeProfit = Math.max(takeProfit, currentPrice * 1.01, entryPrice * (1 + MIN_PROFIT_RATIO));
            stopLoss = Math.min(stopLoss, currentPrice * 0.99, entryPrice * (1 - MIN_PROFIT_RATIO));

            // 检查盈亏比
            const profit = takeProfit - entryPrice;
            const loss = entryPrice - stopLoss;
            if (profit / loss < MIN_RISK_REWARD) {
                takeProfit = entryPrice + loss * MIN_RISK_REWARD;
            }

            // 最终验证
            if (takeProfit <= entryPrice) takeProfit = entryPrice * 1.02;
            if (stopLoss >= entryPrice) stopLoss = entryPrice * 0.98;

            return {
                takeProfit: adjustPrecision(symbol, takeProfit),
                stopLoss: adjustPrecision(symbol, stopLoss)
            };

        } else {
            // ============= 做空场景 =============
            let takeProfit = entryPrice - atr * ATR_MULTIPLIER_TP;
            let stopLoss = entryPrice + atr * ATR_MULTIPLIER_SL;

            // 应用支撑阻力约束
            if (supportResistance.support) {
                const supportLevel = supportResistance.support * (1 + SUPPORT_RESISTANCE_BUFFER);
                takeProfit = Math.max(takeProfit, supportLevel);
            }
            if (supportResistance.resistance) {
                const resistanceLevel = supportResistance.resistance * (1 - SUPPORT_RESISTANCE_BUFFER);
                stopLoss = Math.min(stopLoss, resistanceLevel);
            }

            // 确保价格合理性
            takeProfit = Math.min(takeProfit, currentPrice * 0.99, entryPrice * (1 - MIN_PROFIT_RATIO));
            stopLoss = Math.max(stopLoss, currentPrice * 1.01, entryPrice * (1 + MIN_PROFIT_RATIO));

            // 检查盈亏比
            const profit = entryPrice - takeProfit;
            const loss = stopLoss - entryPrice;
            if (profit / loss < MIN_RISK_REWARD) {
                takeProfit = entryPrice - loss * MIN_RISK_REWARD;
            }

            // 最终验证
            if (takeProfit >= entryPrice) takeProfit = entryPrice * 0.98;
            if (stopLoss <= entryPrice) stopLoss = entryPrice * 1.02;

            return {
                takeProfit: adjustPrecision(symbol, takeProfit),
                stopLoss: adjustPrecision(symbol, stopLoss)
            };
        }

    } catch (error) {
        log(`❌ ${symbol} 动态价格计算失败: ${error.message}`);
        
        // 失败时使用保守的默认值
        const defaultProfitRatio = 0.02;
        const defaultLossRatio = 0.01;
        
        if (side === 'BUY') {
            return {
                takeProfit: adjustPrecision(symbol, entryPrice * (1 + defaultProfitRatio)),
                stopLoss: adjustPrecision(symbol, entryPrice * (1 - defaultLossRatio))
            };
        } else {
            return {
                takeProfit: adjustPrecision(symbol, entryPrice * (1 - defaultProfitRatio)),
                stopLoss: adjustPrecision(symbol, entryPrice * (1 + defaultLossRatio))
            };
        }
    }
}

/**
 * 计算盈亏比（防止除零错误）
 */
function calculateProfitRatio(entryPrice, takeProfit, stopLoss) {
    if (entryPrice === stopLoss) {
        return 'N/A';
    }
    
    const profit = Math.abs(takeProfit - entryPrice);
    const loss = Math.abs(entryPrice - stopLoss);
    
    if (loss === 0) {
        return 'Infinity:1';
    }
    
    const ratio = (profit / loss).toFixed(2);
    return `${ratio}:1`;
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