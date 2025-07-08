// index.js - 启动主入口
const { initTelegramBot } = require('./telegram/bot');
const { startScheduler } = require('./scheduler/cron');
const { cacheTopSymbols } = require('./utils/cache');
const { log } = require('./utils/logger');
const config = require('./config/config');

(async () => {
  try {
    log('🚀 启动自动交易策略服务...');
    log('Telegram Token:', config.telegram.token);
    await cacheTopSymbols();          // 启动时获取Top50币种
    await initTelegramBot();          // 初始化 TG 按钮控制
    await startScheduler();           // 定时策略
  } catch (error) {
    console.error('❌ 启动失败:', error.message);
  }
})();
