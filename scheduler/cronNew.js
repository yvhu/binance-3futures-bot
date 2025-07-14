const cron = require('node-cron');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/bot');
const { getCachedTopSymbols } = require('../utils/cache');
const { getTopLongShortSymbols } = require('../strategy/selectorRun');
const { placeOrder } = require('../binance/trade');
const { checkAndCloseLosingPositions } = require('../strategy/checkPositions')

async function startSchedulerNew() {
  cron.schedule('*/3 * * * *', async () => {
    if (serviceStatus.running) {
      /**
       * 做出如下调整
       * 1. 下单数量，单笔10U 可配置BOT。
       * 2. 每次下单前先检查持仓情况
       *  2.1 如果当前收益率为负，卖出
       *  2.2 如果当前收益率为正，观察前一个收盘价是否跌破EMA(21),前一个收盘价在BOLL中轨上方
       */
      // 检查是否平仓
      await checkAndCloseLosingPositions()

      log('⏱ 执行定时策略轮询...');
      const topSymbols = getCachedTopSymbols();
      log(`✅ 获取T50缓存数据`);
      const { topLong, topShort } = await getTopLongShortSymbols(topSymbols, 1); // 获取前3多空币种
      if(topLong.length > 0) {for (const long of topLong) {
        // await openPosition(long.symbol, 'LONG', config.positionRatio);
        log(`✅ 开始下单`);
        await placeOrder(long.symbol, 'BUY'); // 策略运行时才下单
        log(`✅ 做多 ${long.symbol}，信号分数 ${long.score}`);
      }}

      if(topShort.length > 0) {for (const short of topShort) {
        // await openPosition(short.symbol, 'SHORT', config.positionRatio);
        log(`✅ 开始下单`);
        await placeOrder(long.symbol, 'SELL'); // 策略运行时才下单
        log(`✅ 做空 ${short.symbol}，信号分数 ${short.score}`);
      }}
    }
  });
  log('✅ 定时器启动，每3分钟运行一次');
}

module.exports = { startSchedulerNew };
