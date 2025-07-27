const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbols, getTopLongShortSymbolsTest } = require('../strategy/selectorRun');
const { placeOrder, getLossIncomes, cleanUpOrphanedOrders, placeOrderTest } = require('../binance/trade');
const { checkAndCloseLosingPositions } = require('../strategy/checkPositions')
const { refreshPositionsFromBinance, getPosition } = require('../utils/position')
const { getAccountTrades } = require('../binance/trade'); // 你需自己实现或引入获取交易记录的函数
const { removeFromTopSymbols, getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息
const config = require('../config/config');
// const { getOpenTrades } = require('../db/trade')
const { db, hourlyStats, trade } = require('../db');

async function startSchedulerTest() {
    // 3分钟策略主循环
    cron.schedule('*/5 * * * *', async () => {
        try {
            log(`⏰ 开始${config.interval}策略循环任务`);

            // ==================== 平仓逻辑 ====================
            try {
                const openTrades = await trade.getOpenTrades(db);
                log(`✅ 发现 ${openTrades.length} 个未平仓交易`);

                for (const openTrade of openTrades) {
                    try {
                        log(`🔄 处理未平仓交易 ID: ${openTrade.id}, 币种: ${openTrade.symbol}, 方向: ${openTrade.side}`);

                        // 确定平仓方向（与开仓相反）
                        const closeSide = openTrade.side === 'BUY' ? 'SELL' : 'BUY';

                        await placeOrderTest(
                            openTrade.id,
                            openTrade.symbol,
                            closeSide,
                            openTrade.quantity.toString()
                        );

                        log(`✅ 成功平仓交易 ID: ${openTrade.id}`);
                    } catch (err) {
                        log(`❌ 平仓失败 ID: ${openTrade.id}, 错误: ${err.message}`);
                        // 继续处理下一个交易
                        continue;
                    }
                }
            } catch (err) {
                log(`❌ 获取未平仓交易失败: ${err.message}`);
            }

            log(`✅ 平仓任务完成`);

            // ==================== 开仓逻辑 ====================
            try {
                const topSymbols = getCachedTopSymbols();
                const { topLong, topShort } = await getTopLongShortSymbolsTest(topSymbols, 1, config.interval);

                // 处理做多交易
                if (topLong.length > 0) {
                    log(`📈 发现 ${topLong.length} 个做多机会`);
                    for (const long of topLong) {
                        try {
                            log(`尝试做多: ${long.symbol}`);
                            await placeOrderTest(null, long.symbol, 'BUY');
                            log(`✅ 做多成功: ${long.symbol}`);
                        } catch (err) {
                            log(`❌ 做多下单失败：${long.symbol}，原因: ${err.message}`);
                        }
                    }
                } else {
                    log(`📉 未发现做多机会`);
                }

                // 处理做空交易
                if (topShort.length > 0) {
                    log(`📉 发现 ${topShort.length} 个做空机会`);
                    for (const short of topShort) {
                        try {
                            log(`尝试做空: ${short.symbol}`);
                            await placeOrderTest(null, short.symbol, 'SELL');
                            log(`✅ 做空成功: ${short.symbol}`);
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

            log(`🎉 ${config.interval}策略循环任务完成`);
        } catch (err) {
            log(`❗❗ 策略循环发生未捕获错误: ${err.message}`);
        }
    });

    // 每小时执行一次（在每分钟的第0分钟执行）
    cron.schedule('0 * * * *', async () => {
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
}


module.exports = { startSchedulerTest };
