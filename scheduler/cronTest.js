const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbols, getTopLongShortSymbolsTest } = require('../strategy/selectorRun');
const { placeOrder, getLossIncomes, cleanUpOrphanedOrders, placeOrderTest, placeOrderTestNew, fetchAllPositions, fetchOpenOrders, cancelOrder, setupStopLossOrder, setupTakeProfitOrder, isInTradingTimeRange } = require('../binance/trade');
const { checkAndCloseLosingPositions } = require('../strategy/checkPositions')
const { refreshPositionsFromBinance, getPosition } = require('../utils/position')
const { getAccountTrades } = require('../binance/trade'); // 你需自己实现或引入获取交易记录的函数
const { removeFromTopSymbols, getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息
const { cacheTopSymbols } = require('../utils/cache');
const config = require('../config/config');
// const { getOpenTrades } = require('../db/trade')
const { db, hourlyStats, trade } = require('../db');
const { enableStopLoss, stopLossRate, enableTakeProfit, takeProfitRate } = config.riskControl;
const moment = require('moment-timezone');

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
                        // await placeOrderTestNew(
                        //     openTrade.id,
                        //     openTrade.symbol,
                        //     closeSide,
                        //     openTrade.quantity.toString()
                        // );
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
                            // await placeOrderTestNew(null, long.symbol, 'BUY');
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
                            // await placeOrderTestNew(null, short.symbol, 'SELL');
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
                    for (const position of positions) {
                        const { symbol, positionAmt, entryPrice, positionSide } = position;
                        const side = parseFloat(positionAmt) > 0 ? 'BUY' : 'SELL'; // 自动判断多空方向

                        try {
                            // log(`\n=== 处理持仓 ${symbol} ===`);
                            // log(`方向: ${positionSide} | 数量: ${positionAmt} | 开仓价: ${entryPrice}`);

                            // 设置止损单
                            if (enableStopLoss) {
                                await setupStopLossOrder(symbol, side, entryPrice);
                                log(`✅ ${symbol} 止损单设置完成`);
                            }

                            // 设置止盈单（检查时间段）
                            const serverTime = new Date();
                            const formattedTime = moment(serverTime)
                                .local() // 使用服务器本地时区
                                .format('YYYY年MM月DD日 HH:mm');
                            const enableTakeProfitByTime = isInTradingTimeRange(config.takeProfitTimeRanges);
                            sendTelegramMessage(`✅ 当前时间处于设置 ${enableTakeProfitByTime ? '止盈' : '不止盈'} 时间段: ${formattedTime}`);
                            if (enableTakeProfit && enableTakeProfitByTime) {
                                await setupTakeProfitOrder(symbol, side, entryPrice);
                                log(`✅ ${symbol} 止盈单设置完成`);
                            }

                        } catch (error) {
                            log(`❌ ${symbol} 持仓处理失败: ${error.message}`);
                            // 继续处理下一个持仓，不中断循环
                        }
                    }
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

    // 每小时执行一次（在每分钟的第0分钟执行）
    cron.schedule('5 * * * *', async () => {
        try {
            log(`⏰ 开始执行每小时盈亏计算任务`);

            // 1. 获取过去一小时的时间范围
            const now = new Date();
            const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 1, 0, 0);
            const hourEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 1, 59, 59);

            log(`统计时间范围: ${hourStart.toLocaleString()} 至 ${hourEnd.toLocaleString()}`);

            // 2. 查询过去一小时内的平仓交易
            const hourlyTrades = await trade.getTradesByTimeRange(db, hourStart.toISOString(), hourEnd.toISOString());

            // 3. 计算本小时盈亏
            // 初始化盈亏统计变量
            let totalProfit = 0;          // 累计总盈亏金额（USDT）
            let longProfit = 0;           // 多头盈利总额（USDT）
            let longLoss = 0;             // 多头亏损总额（USDT，负值）
            let shortProfit = 0;          // 空头盈利总额（USDT）
            let shortLoss = 0;            // 空头亏损总额（USDT，负值）
            let tradeCount = 0;           // 总交易笔数
            let longWinCount = 0;         // 多头盈利交易次数
            let longLossCount = 0;        // 多头亏损交易次数
            let shortWinCount = 0;        // 空头盈利交易次数
            let shortLossCount = 0;       // 空头亏损交易次数

            // 收益率相关统计变量
            let totalReturnRate = 0;      // 累计总收益率（%），用于计算平均收益率
            let maxReturnRate = -Infinity; // 单笔交易最高收益率（%），初始设为极小值
            let minReturnRate = Infinity;  // 单笔交易最低收益率（%），初始设为极大值

            for (const t of hourlyTrades) {
                if (t.status === 'closed' && t.profit !== null) {
                    totalProfit += t.profit;
                    tradeCount++;

                    // 计算收益率 (profit / cost)
                    const cost = t.quantity * t.entry_price;
                    const returnRate = cost > 0 ? (t.profit / cost) * 100 : 0;

                    totalReturnRate += returnRate;

                    // 计算基于max_price和min_price的收益率
                    if (t.max_price && t.min_price) {
                        // 计算最高点收益率
                        const maxPriceReturn = ((t.max_price - t.entry_price) / t.entry_price) * 100 * (t.side === 'BUY' ? 1 : -1);
                        // 计算最低点收益率
                        const minPriceReturn = ((t.min_price - t.entry_price) / t.entry_price) * 100 * (t.side === 'BUY' ? 1 : -1);

                        // 更新最高和最低收益率
                        if (maxPriceReturn > maxReturnRate) maxReturnRate = maxPriceReturn;
                        if (minPriceReturn < minReturnRate) minReturnRate = minPriceReturn;
                    } else {
                        // 如果没有max_price和min_price数据，则使用平仓收益率
                        if (returnRate > maxReturnRate) maxReturnRate = returnRate;
                        if (returnRate < minReturnRate) minReturnRate = returnRate;
                    }

                    if (t.side === 'BUY') {
                        if (t.profit >= 0) {
                            longProfit += t.profit;
                            longWinCount++;
                        } else {
                            longLoss += t.profit;
                            longLossCount++;
                        }
                    } else { // SELL
                        if (t.profit >= 0) {
                            shortProfit += t.profit;
                            shortWinCount++;
                        } else {
                            shortLoss += t.profit;
                            shortLossCount++;
                        }
                    }
                }
            }

            // 4. 准备统计结果
            const stats = {
                hour: hourStart.toISOString(),
                total_profit: totalProfit,
                long_profit: longProfit,
                long_loss: longLoss,
                short_profit: shortProfit,
                short_loss: shortLoss,
                trade_count: tradeCount,
                long_win_count: longWinCount,
                long_loss_count: longLossCount,
                short_win_count: shortWinCount,
                short_loss_count: shortLossCount,
                long_win_rate: longWinCount + longLossCount > 0
                    ? (longWinCount / (longWinCount + longLossCount) * 100)
                    : 0,
                short_win_rate: shortWinCount + shortLossCount > 0
                    ? (shortWinCount / (shortWinCount + shortLossCount) * 100)
                    : 0,
                avg_profit_per_trade: tradeCount > 0 ? totalProfit / tradeCount : 0,
                avg_return_rate: tradeCount > 0 ? totalReturnRate / tradeCount : 0,
                max_return_rate: maxReturnRate !== -Infinity ? maxReturnRate : 0,
                min_return_rate: minReturnRate !== Infinity ? minReturnRate : 0
            };

            // 5. 记录统计结果
            await hourlyStats.record(db, stats);

            // 6. 发送通知 - 更新消息内容
            const message = `
    📊 小时盈亏统计 (${hourStart.toLocaleString()} - ${hourEnd.toLocaleString()})
    ────────────────
    🔹 总盈亏: ${totalProfit.toFixed(4)} USDT
    🔹 交易次数: ${tradeCount}

    做多统计:
    ✅ 盈利次数: ${longWinCount}次 | 盈利总额: ${longProfit.toFixed(4)} USDT
    ❌ 亏损次数: ${longLossCount}次 | 亏损总额: ${Math.abs(longLoss).toFixed(4)} USDT
    📈 净盈亏: ${(longProfit + longLoss).toFixed(4)} USDT
    🎯 胜率: ${stats.long_win_rate.toFixed(2)}%

    做空统计:
    ✅ 盈利次数: ${shortWinCount}次 | 盈利总额: ${shortProfit.toFixed(4)} USDT
    ❌ 亏损次数: ${shortLossCount}次 | 亏损总额: ${Math.abs(shortLoss).toFixed(4)} USDT
    📉 净盈亏: ${(shortProfit + shortLoss).toFixed(4)} USDT
    🎯 胜率: ${stats.short_win_rate.toFixed(2)}%

    平均每笔盈利: ${stats.avg_profit_per_trade.toFixed(4)} USDT
    📊 收益率统计:
    ├─ 平均收益率: ${stats.avg_return_rate.toFixed(2)}%
    ├─ 最高收益率: ${stats.max_return_rate.toFixed(2)}%
    └─ 最低收益率: ${stats.min_return_rate.toFixed(2)}%
    ────────────────`;

            await sendTelegramMessage(message);
            log(`✅ 小时盈亏统计完成`);

        } catch (err) {
            log(`❌ 每小时盈亏计算失败: ${err.message}`);
            await sendTelegramMessage(`⚠️ 每小时统计出错: ${err.message}`);
        }
    });

    // 每12小时执行的任务 - 刷新Top50币种
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
