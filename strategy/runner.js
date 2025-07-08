const { getSelectedSymbol } = require('../utils/cache');
const { analyzeSymbol } = require('../indicators/analyzer');
const { sendTelegramMessage } = require('../telegram/bot');
const { placeOrder, closePositionIfNeeded } = require('../binance/trade');
const config = require('../config/config');
const { log } = require('../utils/logger');

async function runStrategyCycle() {
  const symbol = getSelectedSymbol();
  if (!symbol) {
    log('⚠️ 未选择任何币种，跳过轮询');
    return;
  }
  log(`📉 ${symbol} 开始分析信号`);
  const result = await analyzeSymbol(symbol, config.interval);
  await closePositionIfNeeded(symbol); // 检查是否应平仓
  log(`📉 ${symbol} 做多做空信号`);

  if (result.shouldLong) {
    await placeOrder(symbol, 'BUY');
  } else if (result.shouldShort) {
    await placeOrder(symbol, 'SELL');
  } else {
    log(`📉 ${symbol} 当前无入场信号`);
  }
}

module.exports = {
  runStrategyCycle
};
