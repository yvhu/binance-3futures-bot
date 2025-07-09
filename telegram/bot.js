const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { clearSelectedSymbol, cacheSelectedSymbol, cacheTopSymbols } = require('../utils/cache');
const { runStrategyCycle } = require('../strategy/runner');
const { getSelectedSymbol } = require('../utils/cache');
const { selectBestSymbols } = require('../strategy/selector');
const { placeOrder } = require('../binance/trade');
const { refreshPositionsFromBinance } = require('../utils/position');

let bot;

// 策略状态（控制开启/暂停）
const serviceStatus = {
  running: false
};


// 封装发送信息函数
function sendTelegramMessage(text) {
  if (bot && config.telegram.chatId && text) {
    return bot.sendMessage(config.telegram.chatId, text);
  }
}

// 初始化 Telegram Bot
async function initTelegramBot() {
  bot = new TelegramBot(config.telegram.token, { polling: true });
  log('🤖 Telegram Bot 已启动');

  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    await handleCommand(data, chatId);
  });

  sendMainMenu();
}

// 发送主按钮菜单
async function sendMainMenu() {
  const buttons = [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新多空数据', callback_data: 'refresh_signal' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }, { text: '🧹 清空已选币种', callback_data: 'clear_selected' }]
  ];

  try {
    const { longList, shortList } = await selectBestSymbols();
    if (longList.length > 0) {
      const longButtons = longList.map(item => [{ text: `做多 ${item.symbol}`, callback_data: `long_${item.symbol}` }]);
      buttons.push(...longButtons);
    }
    if (shortList.length > 0) {
      const shortButtons = shortList.map(item => [{ text: `做空 ${item.symbol}`, callback_data: `short_${item.symbol}` }]);
      buttons.push(...shortButtons);
    }
  } catch (err) {
    log('⚠️ 选币失败:', err.message);
  }

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

// 处理按钮指令
async function handleCommand(data, chatId) {
  if (data === 'start') {
    serviceStatus.running = true;
    sendTelegramMessage('✅ 策略已启动');
  } else if (data === 'stop') {
    serviceStatus.running = false;
    sendTelegramMessage('⏸ 策略已暂停');
  } else if (data === 'run_now') {
    sendTelegramMessage('🚀 手动执行策略...');
    await runStrategyCycle();
  } else if (data === 'status') {
    const selectedSymbol = getSelectedSymbol();  // 是字符串，比如 'BTCUSDT'
    const statusText = `📊 当前策略状态：
- 状态：${serviceStatus.running ? '✅ 运行中' : '⏸ 暂停中'}
- 选中币种：${selectedSymbol || '无'}
- 方向：${selectedSymbol?.toLowerCase().includes('short') ? '做空' : (selectedSymbol ? '做多' : '无')}`;
    sendTelegramMessage(statusText);
  } else if (data === 'refresh_top50') {
    await cacheTopSymbols(); // 刷新 Top50 缓存
    sendTelegramMessage('✅ 已刷新24小时交易量 Top50 币种');
    // 注意这里保留刷新按钮面板，因为如果T50数据都变了，那面板数据理应跟着改变
    await sendMainMenu();
  } else if (data === 'refresh_signal') {
    await sendMainMenu(); // 单独刷新多空信号按钮面板
    sendTelegramMessage('🔄 已刷新多空数据按钮面板');
  } else if (data === 'refresh_position') {
    await refreshPositionsFromBinance();
    sendTelegramMessage('📦 持仓已刷新（从币安获取最新）');
  } else if (data.startsWith('long_') || data.startsWith('short_')) {
    const symbol = data.split('_')[1];
    const isLong = data.startsWith('long_');
    const direction = data.startsWith('long_') ? '做多' : '做空';
    cacheSelectedSymbol(symbol);
    sendTelegramMessage(`📌 已选择币种：${symbol}，方向：${direction}`);
    try {
      // ⬇️ ⬇️ ⬇️ ✅ 立即执行市价开仓（BUY 或 SELL）
      const orderSide = isLong ? 'BUY' : 'SELL';
      if (serviceStatus.running) {
        await placeOrder(symbol, orderSide);// ✅ 策略运行时才下单
      } else {
        sendTelegramMessage('⚠️ 当前策略已暂停，仅缓存选币，不会下单');
      }
    } catch (err) {
      // 报错已经在 placeOrder 内部处理，这里可以再打印日志
      console.error(`下单失败: ${symbol}`, err.message);
    }
  } else if (data === 'clear_selected') {
    clearSelectedSymbol();
    sendTelegramMessage('🧹 已清空选中币种缓存');
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage,
  serviceStatus
};
