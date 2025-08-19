const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbolsTest } = require('../strategy/selectorRun');
const { placeOrderTest, placeOrderTestNew, fetchAllPositions, fetchOpenOrders, cancelOrder } = require('../binance/trade');

const { getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息
const { cacheTopSymbols } = require('../utils/cache');
const config = require('../config/config');
const { db, trade } = require('../db');
const { setupDynamicOrdersForAllPositions } = require('./dynamicOrders');

async function startSchedulerTest() {
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

                const openTrades = await trade.getOpenTrades(db);
                // log(`✅ 发现 ${openTrades.length} 个本地未平仓交易`);

                for (const openTrade of openTrades) {
                    try {
                        log(`🔄 处理未平仓交易 ID: ${openTrade?.id}, 币种: ${openTrade?.symbol}, 方向: ${openTrade?.side}`);

                        // 确定平仓方向（与开仓相反）
                        const closeSide = openTrade?.side === 'BUY' ? 'SELL' : 'BUY';
                        // 查找匹配的持仓
                        const matchedPosition = positions.find(p => p.symbol === openTrade.symbol);
                        const isPositionSymbol = matchedPosition?.symbol ? true : false
                        if (serviceStatus.running) {
                            // log(`✅ 进入真实交易 tradeId: ${openTrade?.id} symbol:${openTrade?.symbol} side:${closeSide} positionAmt:${openTrade?.quantity.toString()} matchedPosition.symbol:${matchedPosition?.symbol}`);
                            await placeOrderTestNew(
                                openTrade?.id,
                                openTrade?.symbol,
                                closeSide,
                                // 这里数量取线上数量
                                openTrade?.quantity.toString(),
                                isPositionSymbol
                            );
                        } else {
                            await placeOrderTest(
                                openTrade?.id,
                                openTrade?.symbol,
                                closeSide,
                                openTrade?.quantity.toString(),
                            );
                        }

                        log(`✅ 成功平仓交易 ID: ${openTrade?.id}`);
                    } catch (err) {
                        log(`❌ 平仓失败 ID: ${openTrade?.id}, 错误: ${err.message}`);
                        // 继续处理下一个交易
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
                if (topLong.length > 0) {
                    // log(`📈 发现 ${topLong.length} 个做多机会`);
                    for (const long of topLong) {
                        try {
                            // log(`尝试做多: ${long.symbol}`);
                            if (serviceStatus.running) {
                                // log(`✅ 进入真实交易`);
                                await placeOrderTestNew(null, long.symbol, 'BUY', false);
                            } else {
                                await placeOrderTest(null, long.symbol, 'BUY');
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
                if (topShort.length > 0) {
                    // log(`📉 发现 ${topShort.length} 个做空机会`);
                    for (const short of topShort) {
                        try {
                            // log(`尝试做空: ${short.symbol}`);
                            if (serviceStatus.running) {
                                // log(`✅ 进入真实交易`);
                                await placeOrderTestNew(null, short.symbol, 'SELL', false);
                            } else {
                                await placeOrderTest(null, short.symbol, 'SELL');
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
}


module.exports = { startSchedulerTest };
