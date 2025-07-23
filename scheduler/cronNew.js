const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getTopLongShortSymbols } = require('../strategy/selectorRun');
const { placeOrder, getLossIncomes } = require('../binance/trade');
const { checkAndCloseLosingPositions } = require('../strategy/checkPositions')
const { refreshPositionsFromBinance, getPosition } = require('../utils/position')
const { getAccountTrades } = require('../binance/trade'); // 你需自己实现或引入获取交易记录的函数
const { removeFromTopSymbols, getCachedTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('../telegram/messenger'); // Telegram发送消息

async function checkLossTradesAndFilter() {
  await sendTelegramMessage(`⚠️ 15min开始检查亏损持仓`);
  try {
    const topSymbols = getCachedTopSymbols();

    // 当前时间和15分钟前时间戳(ms)
    const now = Date.now();
    const fifteenMinutesAgo = now - 15 * 60 * 1000;

    // 格式化为 YYYY-MM-DD HH:mm:ss
    const formatFullDateTime = (date) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const currentFormatted = formatFullDateTime(new Date(now));
    const pastFormatted = formatFullDateTime(new Date(fifteenMinutesAgo));

    // log(`检查时间范围: ${pastFormatted} --- ${currentFormatted}`);
    await sendTelegramMessage(`🧯 检查时间范围：${pastFormatted} --- ${currentFormatted}`);

    for (const symbol of topSymbols) {
      // 获取该 symbol 在15分钟内的亏损平仓记录
      const lossIncomes = await getLossIncomes(symbol, fifteenMinutesAgo, now);

      if (lossIncomes.length > 2) {
        log(`⚠️ ${symbol} 近15分钟亏损平仓次数 ${lossIncomes.length} 次，移出策略币种`);

        // 检查是否有持仓，有则立即平仓
        const position = getPosition(symbol);
        if (position && position.positionAmt && Math.abs(position.positionAmt) > 0) {
          const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
          try {
            await placeOrder(symbol, oppositeSide, Math.abs(position.positionAmt));
            log(`🧯 ${symbol} 已因连续亏损自动平仓`);
            await sendTelegramMessage(`🧯 ${symbol} 因连续亏损已平仓`);
          } catch (err) {
            log(`❌ 平仓 ${symbol} 失败: ${err.message}`);
            await sendTelegramMessage(`❌ 平仓 ${symbol} 失败，原因: ${err.message}`);
          }
        }

        // 移除策略缓存
        removeFromTopSymbols(symbol);
        await sendTelegramMessage(`⚠️ ${symbol} 连续亏损已从策略池中移除`);
      }
    }
  } catch (err) {
    log(`❌ checkLossTradesAndFilter 执行异常: ${err.stack}`);
    await sendTelegramMessage(`❌ 检查亏损持仓异常：${err.message}`);
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
      // await sendTelegramMessage(`⚠️ 参与轮询的数量${topSymbols.length}`);
      log(`✅ 获取T50缓存数据`);
      const { topLong, topShort } = await getTopLongShortSymbols(topSymbols, 1); // 获取前1多空币种
      if (topLong.length > 0) {
        for (const long of topLong) {
          try {
            log(`✅ 开始做多下单 ${long.symbol}`);
            await placeOrder(long.symbol, 'BUY');
            log(`✅ 做多 ${long.symbol}，信号分数 ${long.score}`);
          } catch (err) {
            log(`❌ 做多下单失败：${long.symbol}，原因: ${err.message}`);
          }
        }
      }

      if (topShort.length > 0) {
        for (const short of topShort) {
          try {
            log(`✅ 开始做空下单 ${short.symbol}`);
            await placeOrder(short.symbol, 'SELL');
            log(`✅ 做空 ${short.symbol}，信号分数 ${short.score}`);
          } catch (err) {
            log(`❌ 做空下单失败：${short.symbol}，原因: ${err.message}`);
          }
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
