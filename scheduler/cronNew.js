const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getCachedTopSymbols } = require('../utils/cache');
const { getTopLongShortSymbols } = require('../strategy/selectorRun');

async function startSchedulerNew() {
  cron.schedule('*/3 * * * *', async () => {
    if (serviceStatus.running) {
      log('⏱ 执行定时策略轮询...');
      // const topSymbols = await getTopSymbols(); // 从缓存中加载Top50
      const topSymbols = getCachedTopSymbols();
      const { topLong, topShort } = await getTopLongShortSymbols(topSymbols, 1); // 获取前3多空币种
      for (const long of topLong) {
        // await openPosition(long.symbol, 'LONG', config.positionRatio);
        await placeOrder(symbol, 'BUY'); // 策略运行时才下单
        log(`✅ 做多 ${long.symbol}，信号分数 ${long.score}`);
      }

      for (const short of topShort) {
        // await openPosition(short.symbol, 'SHORT', config.positionRatio);
        await placeOrder(symbol, 'SELL'); // 策略运行时才下单
        log(`✅ 做空 ${short.symbol}，信号分数 ${short.score}`);
      }
    }
  });
  log('✅ 定时器启动，每3分钟运行一次');
}

module.exports = { startSchedulerNew };
