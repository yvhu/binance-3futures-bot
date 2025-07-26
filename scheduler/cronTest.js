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
    cron.schedule('*/3 * * * *', async () => {
        try {
            log(`⏰ 开始3分钟策略循环任务`);

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

            log(`🎉 3分钟策略循环任务完成`);
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
            let totalProfit = 0;
            let longProfit = 0;    // 做多盈利总和
            let longLoss = 0;      // 做多亏损总和
            let shortProfit = 0;   // 做空盈利总和
            let shortLoss = 0;     // 做空亏损总和
            let tradeCount = 0;
            let longWinCount = 0;  // 做多盈利次数
            let longLossCount = 0; // 做多亏损次数
            let shortWinCount = 0; // 做空盈利次数
            let shortLossCount = 0;// 做空亏损次数

            hourlyTrades.forEach(t => {
                if (t.status === 'closed' && t.profit !== null) {
                    totalProfit += t.profit;
                    tradeCount++;

                    if (t.side === 'BUY') {
                        if (t.profit >= 0) {
                            longProfit += t.profit;
                            longWinCount++;
                        } else {
                            longLoss += t.profit; // 亏损是负值
                            longLossCount++;
                        }
                    } else { // SELL
                        if (t.profit >= 0) {
                            shortProfit += t.profit;
                            shortWinCount++;
                        } else {
                            shortLoss += t.profit; // 亏损是负值
                            shortLossCount++;
                        }
                    }
                }
            });

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
                avg_profit_per_trade: tradeCount > 0 ? totalProfit / tradeCount : 0
            };

            // 5. 记录统计结果
            await hourlyStats.record(db, stats);

            // 6. 发送通知
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
