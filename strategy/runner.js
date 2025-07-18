const { getSelectedSymbol } = require('../utils/cache');
const { analyzeSymbol } = require('../indicators/analyzer');
const { placeOrder, closePositionIfNeeded } = require('../binance/trade');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { hasPosition } = require('../utils/position');
const { refreshPositionsFromBinance, getPosition } = require('../utils/position');
const { getSignalMode } = require('../utils/tg-settings');

async function runStrategyCycle() {
  const symbol = getSelectedSymbol();
  if (!symbol) {
    log('⚠️ 未选择任何币种，跳过本轮策略执行');
    return;
  }
  if (hasPosition(symbol)) {
    log(`📦 ${symbol} 当前有持仓，检查是否应平仓...`);
    await closePositionIfNeeded(symbol);
    return;
  }

  // ✅ 无持仓，进行信号分析并判断是否入场
  log(`📊 ${symbol} 当前无持仓，开始分析信号...`);
  try {
    const result = await analyzeSymbol(symbol, config.interval);
    const signalMode = getSignalMode();

    if (signalMode === 'NEGATE') {
      if (result.shouldShort) {
        log(`📈 ${symbol} 检测到做多信号（模式 取反）`);
        await placeOrder(symbol, 'BUY');
      } else if (result.shouldLong) {
        log(`📉 ${symbol} 检测到做空信号（模式 取反）`);
        await placeOrder(symbol, 'SELL');
      } else {
        log(`🔍 ${symbol} 当前无明确入场信号（模式 取反）`);
      }
    } else {
      if (result.shouldLong) {
        log(`📈 ${symbol} 检测到做多信号（模式 取正）`);
        await placeOrder(symbol, 'BUY');
      } else if (result.shouldShortshouldLong) {
        log(`📉 ${symbol} 检测到做空信号（模式 取正）`);
        await placeOrder(symbol, 'SELL');
      } else {
        log(`🔍 ${symbol} 当前无明确入场信号（模式 取正）`);
      }
    }
  } catch (err) {
    log(`❌ 分析信号失败：${err.message}`);
  }
  refreshPositionsFromBinance()
}


module.exports = {
  runStrategyCycle
};
