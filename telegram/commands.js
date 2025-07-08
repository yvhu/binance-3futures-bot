const { cacheSelectedSymbol, cacheTopSymbols } = require('../utils/cache');
const { sendTelegramMessage } = require('./bot');
const { runStrategyCycle } = require('../strategy/runner');

const serviceStatus = {
  running: false
};

async function handleCommand(data, chatId, bot) {
  if (data === 'start') {
    serviceStatus.running = true;
    sendTelegramMessage('✅ 策略已启动');
  } else if (data === 'stop') {
    serviceStatus.running = false;
    sendTelegramMessage('⏸ 策略已暂停');
  } else if (data === 'run_now') {
    sendTelegramMessage('🚀 手动执行策略...');
    await runStrategyCycle();
  } else if (data === 'refresh_top50') {
    await cacheTopSymbols();
    sendTelegramMessage('✅ 已刷新24小时交易量 Top50 币种');
  } else if (data.startsWith('long_') || data.startsWith('short_')) {
    const symbol = data.split('_')[1];
    const direction = data.startsWith('long_') ? '做多' : '做空';
    cacheSelectedSymbol(symbol);
    sendTelegramMessage(`📌 已选择币种：${symbol}，方向：${direction}`);
  }
}

module.exports = {
  handleCommand,
  serviceStatus
};
