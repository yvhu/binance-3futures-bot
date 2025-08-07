/**
 * 仅负责发送 Telegram 消息，依赖 telegram/state.js 管理的 bot 实例
 */

const config = require('../config/config');
const { log } = require('../utils/logger');
const { getBot } = require('./state');

/**
 * 发送 Telegram 消息到配置的 chatId
 * @param {string} text 发送的文本消息
 * @returns {Promise}
 */
function sendTelegramMessage(text) {
  const bot = getBot();
  // log(`🤖 发送 Telegram 消息: bot=${!!bot}, chatId=${config.telegram.chatId}, text="${text}"`);
  if (bot && config.telegram.chatId && text) {
    return bot.sendMessage(config.telegram.chatId, text);
  } else {
    log('⚠️ 发送消息失败：bot 未初始化或 chatId/text 缺失');
    return Promise.resolve(); // 避免调用处因无返回拒绝
  }
}

module.exports = {
  sendTelegramMessage,
};
