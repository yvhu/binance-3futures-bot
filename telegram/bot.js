/**
 * Telegram Bot 主要功能模块
 * - 初始化 bot 实例
 * - 绑定按钮事件和回调
 * - 发送主菜单
 * - 处理指令逻辑
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { setBot } = require('./state');
const { sendTelegramMessage } = require('./messenger');

const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * 初始化 Telegram Bot，启动监听，绑定回调事件
 */
async function initTelegramBot() {
  let botOptions = { polling: true };

  if (config.telegram.useProxy && config.telegram.proxyUrl) {
    botOptions.request = {
      agent: new HttpsProxyAgent(config.proxyUrl)
    };
    log(`🌐 使用代理启动 Telegram Bot：${config.proxyUrl}`);
  }

  const bot = new TelegramBot(config.telegram.token, botOptions);
  setBot(bot); // 设置全局 bot 实例，供其他模块获取

  log('🤖 Telegram Bot 已启动');

  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    await handleCommand(data, chatId);
  });

  bot.onText(/\/button/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() === config.telegram.chatId.toString()) {
      await sendMainMenu();
    } else {
      log(`⚠️ 未授权用户尝试使用 /button：${chatId}`);
    }
  });

  await sendMainMenu();
}

/**
 * 发送主控制面板菜单按钮
 */
async function sendMainMenu() {
  const bot = require('./state').getBot();
  if (!bot) {
    log('⚠️ 发送主菜单失败，bot 未初始化');
    return;
  }
  const buttons = [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
  ];

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

/**
 * 处理 Telegram 按钮指令
 * @param {string} data 按钮回调数据
 * @param {number} chatId 用户聊天 ID
 */
async function handleCommand(data, chatId) {
  if (data === 'start') {
    sendTelegramMessage('✅ 策略已启动');
  } else if (data === 'stop') {
    sendTelegramMessage('⏸ 策略已暂停');
  }
}

module.exports = {
  initTelegramBot,
  // sendTelegramMessage,   // 方便外部直接发送消息（内部会通过 state 获取bot）
};
