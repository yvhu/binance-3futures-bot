const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbols } = require('../strategy/selectorRun');
const { placeOrder } = require('../binance/trade');
const { checkAndCloseLosingPositions } = require('../strategy/checkPositions')
const { refreshPositionsFromBinance } = require('../utils/position')
const { getAccountTrades } = require('../binance/trade'); // 你需自己实现或引入获取交易记录的函数
const { removeFromTopSymbols, getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息

async function checkLossTradesAndFilter() {
  try {
    const topSymbols = getCachedTopSymbols();

    // 当前时间和15分钟前时间戳(ms)
    const now = Date.now();
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    for (const symbol of topSymbols) {
      // 获取该symbol最近15分钟内的成交记录
      const trades = await getAccountTrades(symbol, { startTime: fifteenMinutesAgo, endTime: now });
      if (!Array.isArray(trades)) {
        log(`❌ 获取 ${symbol} 交易记录失败或返回格式错误`);
        continue;
      }

      // 统计15分钟内亏损的成交次数
      // 这里假设成交记录中有 realizedProfit 字段，负值代表亏损
      const lossCount = trades.filter(t => t.realizedProfit < 0).length;

      if (lossCount > 2) {
        log(`⚠️ ${symbol} 近15分钟亏损次数超过2次(${lossCount}次)，从策略币种列表移除`);
        removeFromTopSymbols(symbol);
        // 发送Telegram通知
        await sendTelegramMessage(`⚠️ 策略币种筛选：${symbol} 近15分钟亏损次数达到 ${lossCount} 次，已自动从策略币种列表移除。`);      }
    }
  } catch (err) {
    log('❌ 检查交易亏损失败:', err);
  }
}

async function startSchedulerNew() {
  // 3分钟策略主循环
  cron.schedule('*/3 * * * *', async () => {
    if (serviceStatus.running) {
      await refreshPositionsFromBinance();
      await checkAndCloseLosingPositions();

      log('⏱ 执行定时策略轮询...');
      const topSymbols = getCachedTopSymbols();
      log(`✅ 获取T50缓存数据`);
      const { topLong, topShort } = await getTopLongShortSymbols(topSymbols, 1); // 获取前1多空币种
      if (topLong.length > 0) {
        for (const long of topLong) {
          log(`✅ 开始下单`);
          await placeOrder(long.symbol, 'BUY');
          log(`✅ 做多 ${long.symbol}，信号分数 ${long.score}`);
        }
      }
      if (topShort.length > 0) {
        for (const short of topShort) {
          log(`✅ 开始下单`);
          await placeOrder(short.symbol, 'SELL');
          log(`✅ 做空 ${short.symbol}，信号分数 ${short.score}`);
        }
      }
    }
  });

  // 每15分钟检查亏损交易次数，移除表现差的币种
  cron.schedule('*/15 * * * *', async () => {
    if (serviceStatus.running) {
      log('⏱ 执行每15分钟亏损次数检查...');
      await checkLossTradesAndFilter();
    }
  });

  log('✅ 定时器启动，每3分钟执行策略，每15分钟执行亏损检测');
}


module.exports = { startSchedulerNew };
