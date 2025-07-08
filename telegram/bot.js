const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { getCachedTopSymbols, cacheSelectedSymbol, cacheTopSymbols } = require('../utils/cache');
const { runStrategyCycle } = require('../strategy/runner');

let bot;

// 策略状态（控制开启/暂停）
const serviceStatus = {
  running: false
};

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
    [{ text: '🔁 立即执行', callback_data: 'run_now' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }]
  ];

  const topSymbols = getCachedTopSymbols();
  if (topSymbols.length > 0) {
    const longList = topSymbols.slice(0, 5).map(s => [{ text: `做多 ${s}`, callback_data: `long_${s}` }]);
    const shortList = topSymbols.slice(0, 5).map(s => [{ text: `做空 ${s}`, callback_data: `short_${s}` }]);
    buttons.push(...longList);
    buttons.push(...shortList);
  }

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

// 封装发送信息函数
function sendTelegramMessage(text) {
  if (bot && config.telegram.chatId) {
    return bot.sendMessage(config.telegram.chatId, text);
  }
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
  initTelegramBot,
  sendTelegramMessage,
  serviceStatus
};
