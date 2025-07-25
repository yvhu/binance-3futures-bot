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
        /**
         * 1. 获取24小时成交量数据前五十存入数据库
         * 2. 策略币种选择器模块
         */
        // 这里先查询所有未平仓记录，根据记录调用 placeOrderTest 
        const openTrades = trade.getOpenTrades()
        for (const openTrade of openTrades) {
            await placeOrderTest(openTrade.id, openTrade.symbol, (openTrade.side == 'BUY' ? 'SELL' : 'BUY'), openTrade.qtyRaw)
        }

        const topSymbols = getCachedTopSymbols();
        const { topLong, topShort } = await getTopLongShortSymbolsTest(topSymbols, 1, config.interval)
        if (topLong.length > 0) {
            for (const long of topLong) {
                try {
                    await placeOrderTest(long.symbol, 'BUY');
                } catch (err) {
                    log(`❌ 做多下单失败：${long.symbol}，原因: ${err.message}`);
                }
            }
        }

        if (topShort.length > 0) {
            for (const short of topShort) {
                try {
                    await placeOrderTest(long.symbol, 'SELL');
                } catch (err) {
                    log(`❌ 做空下单失败：${short.symbol}，原因: ${err.message}`);
                }
            }
        }
    });

    // 每小时执行一次（在每分钟的第0分钟执行）
    cron.schedule('0 * * * *', async () => {
        try {
            log(`⏰ 开始执行每小时盈亏计算任务`);

            // 1. 获取当前小时开始和结束时间
            const now = new Date();
            const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0);
            const hourEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 59, 59);

            // 2. 查询本小时内平仓的交易
            const hourlyTrades = trade.getTradesByTimeRange(db, hourStart.toISOString(), hourEnd.toISOString());

            // 3. 计算本小时盈亏
            let totalProfit = 0;
            let longProfit = 0;
            let shortProfit = 0;
            let tradeCount = 0;

            hourlyTrades.forEach(t => {
                if (t.status === 'closed' && t.profit) {
                    totalProfit += t.profit;
                    tradeCount++;

                    if (t.side === 'BUY') {
                        longProfit += t.profit;
                    } else {
                        shortProfit += t.profit;
                    }
                }
            });

            // 4. 准备统计结果
            const stats = {
                hour: hourStart.toISOString(),
                total_profit: totalProfit,
                long_profit: longProfit,
                short_profit: shortProfit,
                trade_count: tradeCount,
                avg_profit_per_trade: tradeCount > 0 ? totalProfit / tradeCount : 0
            };

            // 5. 记录统计结果
            hourlyStats.record(db, stats);

            // log(`📊 小时盈亏统计: 
            // 时间: ${hourStart.toLocaleString()} - ${hourEnd.toLocaleString()}
            // 总盈亏: ${totalProfit.toFixed(4)} USDT
            // 做多盈利: ${longProfit.toFixed(4)} USDT
            // 做空盈利: ${shortProfit.toFixed(4)} USDT
            // 交易次数: ${tradeCount}
            // 平均每笔盈利: ${stats.avg_profit_per_trade.toFixed(4)} USDT`);

            await sendTelegramMessage(`📊 小时盈亏统计: 
            时间: ${hourStart.toLocaleString()} - ${hourEnd.toLocaleString()}
            总盈亏: ${totalProfit.toFixed(4)} USDT
            做多盈利: ${longProfit.toFixed(4)} USDT
            做空盈利: ${shortProfit.toFixed(4)} USDT
            交易次数: ${tradeCount}
            平均每笔盈利: ${stats.avg_profit_per_trade.toFixed(4)} USDT`)

        } catch (err) {
            log(`❌ 每小时盈亏计算失败: ${err.message}`);
        }
    });
}


module.exports = { startSchedulerTest };
