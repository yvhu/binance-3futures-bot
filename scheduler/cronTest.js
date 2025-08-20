const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbolsTest } = require('../strategy/selectorRun');
const { placeOrderTestNew, fetchAllPositions, fetchOpenOrders, cancelOrder } = require('../binance/trade');

const { getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息
const { cacheTopSymbols } = require('../utils/cache');
const config = require('../config/config');
const { db, trade } = require('../db');
const { setupDynamicOrdersForAllPositions } = require('./dynamicOrders');
const { checkMarketTrend } = require('./checkMarketTrend')
const { getTrendText, getTradingSuggestion } = require('../utils/utils');

async function startSchedulerTest() {
    let marketTrend = {
        trend: 'neutral',
        confidence: 0,
        lastUpdate: null,
        isOneSided: false
    };
    // 做多条件
    const topLongMap = ['bullish', 'strong_bullish', 'neutral'];
    // 做空条件
    const topShortMap = ['bearish', 'strong_bearish', 'neutral'];
    // 3分钟策略主循环
    cron.schedule('*/15 * * * *', async () => {
        try {
            /**
             * 1. 更新最新仓库信息
             * 2. 发起平仓操作
             * 3. 选出币种
             * 4. 设置 5% 止损
             */
            log(`⏰ 开始${config.interval}策略循环任务`);

            // ==================== 平仓逻辑 ====================
            try {
                log('\n=== 平仓任务 ===');
                // 1. 获取所有线上持仓信息
                const positions = await fetchAllPositions();
                // log('当前持仓:', JSON.stringify(positions, null, 2));

                // 筛选出有实际持仓的部位（positionAmt不为0）
                const activePositions = positions.filter(p => {
                    const positionAmt = parseFloat(p.positionAmt);
                    return positionAmt !== 0 && Math.abs(positionAmt) > 0;
                });

                log(`✅ 发现 ${activePositions.length} 个币安持仓需要平仓`);

                for (const position of activePositions) {
                    try {
                        const symbol = position.symbol;
                        const positionAmt = parseFloat(position.positionAmt);
                        const absPositionAmt = Math.abs(positionAmt);

                        // 确定平仓方向（与持仓数量相反）
                        const closeSide = positionAmt > 0 ? 'SELL' : 'BUY';

                        // log(`🔄 处理持仓 币种: ${symbol}, 数量: ${positionAmt}, 平仓方向: ${closeSide}`);

                        await placeOrderTestNew(
                            symbol,
                            closeSide,
                            absPositionAmt.toString(),
                            true // 确认有持仓
                        );
                        log(`✅ 成功平仓 币种: ${symbol}`);
                    } catch (err) {
                        log(`❌ 平仓失败 币种: ${position.symbol}, 错误: ${err.message}`);
                        // 继续处理下一个持仓
                        continue;
                    }
                }
            } catch (err) {
                log(`❌ 获取未平仓交易失败: ${err.message}`);
            }

            // log(`✅ 平仓任务完成`);

            // ==================== 开仓逻辑 ====================
            try {
                log('\n=== 开仓任务 ===');
                const topSymbols = getCachedTopSymbols();
                const { topLong, topShort } = await getTopLongShortSymbolsTest(topSymbols, 1, config.interval);

                // 处理做多交易
                // if (topLong.length > 0 && topLongMap.includes(marketTrend.trend)) {
                if (topLong.length > 0) {
                    // log(`📈 发现 ${topLong.length} 个做多机会`);
                    for (const long of topLong) {
                        try {
                            // log(`尝试做多: ${long.symbol}`);
                            if (serviceStatus.running) {
                                // log(`✅ 进入真实交易`);
                                await placeOrderTestNew(long.symbol, 'BUY', null, false);
                            }
                            // log(`✅ 做多成功: ${long.symbol}`);
                        } catch (err) {
                            log(`❌ 做多下单失败：${long.symbol}，原因: ${err.message}`);
                        }
                    }
                } else {
                    log(`📉 未发现做多机会`);
                }

                // 处理做空交易
                // if (topShort.length > 0 && topShortMap.includes(marketTrend.trend)) {
                if (topShort.length > 0) {
                    // log(`📉 发现 ${topShort.length} 个做空机会`);
                    for (const short of topShort) {
                        try {
                            // log(`尝试做空: ${short.symbol}`);
                            if (serviceStatus.running) {
                                // log(`✅ 进入真实交易`);
                                await placeOrderTestNew(short.symbol, 'SELL', null, false);
                            }
                            // log(`✅ 做空成功: ${short.symbol}`);
                        } catch (err) {
                            log(`❌ 做空下单失败：${short.symbol}，原因: ${err.message}`);
                        }
                    }
                } else {
                    log(`📈 未发现做空机会`);
                }
            } catch (err) {
                log(`❌ 开仓策略执行失败: ${err.message}`);
            }

            // ==================== 处理持仓 ====================
            try {
                // ==================== 1. 止盈止损 ====================
                const positions = await fetchAllPositions();
                log('\n=== 止盈止损委托 ===');
                if (positions.length === 0) {
                    log('当前无持仓，跳过持仓处理');
                } else {
                    await setupDynamicOrdersForAllPositions(positions);
                }

                // ==================== 2. 取消非持仓委托 ====================
                log('\n=== 检查非持仓委托 ===');
                // 获取当前所有未成交委托
                const openOrders = await fetchOpenOrders();

                if (openOrders.length === 0) {
                    log('当前无未成交委托');
                } else {
                    /**
                     * 构建一个 Map 保存持仓币种及其开仓时间
                     * - key: 币种 symbol
                     * - value: 持仓的开仓时间戳（毫秒）
                     * 
                     * 注意：
                     *   - 这里假设 positions 中存在 updateTime 或 entryTime 表示开仓时间
                     *   - 如果没有，请替换成你系统中记录的真实开仓时间字段
                     */
                    const positionMap = new Map();
                    positions.forEach(pos => {
                        // 优先取 updateTime，没有的话取 entryTime
                        const openTime = new Date(pos?.updateTime).getTime();
                        positionMap.set(pos.symbol, openTime);
                    });

                    // 存放两类需要取消的委托
                    const nonPositionOrders = [];       // 非持仓币种的委托
                    const invalidPositionOrders = [];   // 持仓币种中已失效的委托

                    // 遍历所有未成交委托，按条件分类
                    for (const order of openOrders) {
                        const orderTime = new Date(order?.time).getTime(); // 委托下单时间

                        if (!positionMap.has(order?.symbol)) {
                            // 情况 1：该委托对应的币种没有持仓 → 直接加入非持仓列表
                            nonPositionOrders.push(order);
                        } else {
                            // 情况 2：该委托属于持仓币种
                            const positionOpenTime = positionMap.get(order.symbol);

                            // 如果委托时间早于持仓开仓时间 → 说明是旧的失效委托（可能是上次开仓挂单没撤掉）
                            if (orderTime < positionOpenTime) {
                                invalidPositionOrders.push(order);
                            }
                        }
                    }

                    // 合并所有需要取消的委托
                    const ordersToCancel = [...nonPositionOrders, ...invalidPositionOrders];

                    if (ordersToCancel.length > 0) {
                        // 逐个取消委托
                        for (const order of ordersToCancel) {
                            try {
                                // 格式化委托时间
                                const orderTimeStr = new Date(order.time).toLocaleString();

                                // 计算委托已存在的分钟数
                                const timeDiff = (Date.now() - new Date(order.time).getTime()) / (60 * 1000);

                                log(`⏳ 取消委托: ${order.symbol} (ID: ${order.orderId}) | 委托时间: ${orderTimeStr} | 已存在: ${timeDiff.toFixed(1)}分钟`);

                                // 执行取消
                                await cancelOrder(order.symbol, order.orderId);

                            } catch (error) {
                                // log('取消委托失败error:', JSON.stringify(error, null, 2));
                                log(`❌ 取消委托 ${order.symbol} 失败: ${error.message}`);
                            }
                        }
                    } else {
                        log('未找到需要取消的委托');
                    }
                }


            } catch (error) {
                // 捕获全局错误（如 fetchAllPositions/fetchOpenOrders 失败）
                log(`❌ 全局处理失败: ${error.stack}`);
                throw error; // 根据需求决定是否向上抛出
            }

            log(`🎉 ${config.interval}策略循环任务完成`);
        } catch (err) {
            log(`❗❗ 策略循环发生未捕获错误: ${err.message}`);
        }
    });

    cron.schedule('5 */12 * * *', async () => {
        try {
            log(`⏰ 开始执行12小时Top50币种刷新任务`);
            await cacheTopSymbols(); // 刷新 Top50 缓存
            await sendTelegramMessage('✅ 已刷新24小时交易量 Top50 币种');
            log(`✅ 12小时Top50币种刷新完成`);
        } catch (err) {
            log(`❌ 刷新Top50币种失败: ${err.message}`);
            await sendTelegramMessage(`⚠️ 刷新Top50币种失败: ${err.message}`);
        }
    });

    // 每4小时执行一次市场行情判断
    cron.schedule('*/20 * * * *', async () => {
        try {
            log(`⏰ 开始执行2小时10分钟市场行情判断任务`);

            // 判断市场趋势
            const marketAnalysis = await checkMarketTrend();
            marketTrend = {
                trend: marketAnalysis.trend,
                confidence: marketAnalysis.confidence,
                isOneSided: marketAnalysis.isOneSided,
                lastUpdate: new Date().toISOString()
            };
            // 构建消息内容
            let message = `📊 4小时市场行情分析\n`;
            message += `⏰ 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
            message += `📈 单边行情: ${marketAnalysis.isOneSided ? '是' : '否'}\n`;
            message += `🧭 趋势方向: ${getTrendText(marketAnalysis.trend)}\n`;
            message += `✅ 置信度: ${marketAnalysis.confidence}%\n`;
            message += `🔢 总交易对: ${marketAnalysis.details.summary.total}\n`;
            message += `📈 上涨数量: ${marketAnalysis.details.summary.up}\n`;
            message += `📉 下跌数量: ${marketAnalysis.details.summary.down}\n`;
            message += `📊 平均涨跌幅: ${marketAnalysis.details.summary.averageChange.toFixed(2)}%\n`;
            message += `⚡ 显著变动比例: ${(marketAnalysis.details.summary.significantRatio * 100).toFixed(1)}%`;

            // 添加市场状态建议
            message += `\n💡 建议: ${getTradingSuggestion(marketAnalysis)}`;

            // 发送Telegram消息
            await sendTelegramMessage(message);
            // log(`✅ 4小时市场行情判断完成`);

        } catch (err) {
            log(`❌ 市场行情判断失败: ${err.message}`);
            await sendTelegramMessage(`⚠️ 市场行情判断失败: ${err.message}`);
        }
    });

}


module.exports = { startSchedulerTest };
