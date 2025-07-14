// index.js - 启动主入口
const { initTelegramBot } = require('./telegram/bot');
const { startScheduler } = require('./scheduler/cron');
const { startSchedulerNew } = require('./scheduler/cronNew');
const { cacheTopSymbols } = require('./utils/cache');
const { log } = require('./utils/logger');
const config = require('./config/config');

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未捕获的 Promise 异常：', reason);
});

(async () => {
  try {
    log('🚀 启动自动交易策略服务...');
    log('Telegram Token:', config.telegram.token);
    await initTelegramBot();          // 初始化 TG 按钮控制
    await cacheTopSymbols();          // 启动时获取Top50币种
    // await startScheduler();           // 定时策略
    await startSchedulerNew();
  } catch (error) {
    console.error('❌ 启动失败:', error.message);
  }
})();


/**
 * 1. TG发送的按钮调整
 *  1.1 按钮支持策略选择
 *  1.2 按时定点的发送一次按钮？
 * 2. 获取T50币种缓存
 * 3. 按照策略获取币种并缓存
 * 4. 下单成功
 * ...
 */