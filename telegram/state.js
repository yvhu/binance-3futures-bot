/**
 * 管理 Telegram Bot 实例的状态，提供 set/get 函数
 */

let botInstance = null;

/**
 * 设置全局 bot 实例
 * @param {TelegramBot} instance
 */
function setBot(instance) {
  botInstance = instance;
}

/**
 * 获取全局 bot 实例
 * @returns {TelegramBot|null}
 */
function getBot() {
  return botInstance;
}

module.exports = {
  setBot,
  getBot,
};
