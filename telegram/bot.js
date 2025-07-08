const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const { handleCommand, serviceStatus } = require('./commands');
const { log } = require('../utils/logger');
const { getCachedTopSymbols } = require('../utils/cache');

let bot;

async function initTelegramBot() {
  bot = new TelegramBot(config.telegram.token, { polling: true });
  log('🤖 Telegram Bot 已启动');

  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    await handleCommand(data, chatId, bot);
  });

  sendMainMenu();
}

async function sendMainMenu() {
  const buttons = [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }]
  ];

  const topSymbols = getCachedTopSymbols();
  if (topSymbols.length > 0) {
    const longList = topSymbols.slice(0, 5).map(s => ({ text: `做多 ${s}`, callback_data: `long_${s}` }));
    const shortList = topSymbols.slice(0, 5).map(s => ({ text: `做空 ${s}`, callback_data: `short_${s}` }));
    buttons.push(longList);
    buttons.push(shortList);
  }

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

function sendTelegramMessage(text) {
  if (bot && config.telegram.chatId) {
    return bot.sendMessage(config.telegram.chatId, text);
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage
};
