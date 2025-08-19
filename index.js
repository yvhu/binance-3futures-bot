// index.js - 启动主入口
const { initTelegramBot } = require('./telegram/bot');
const { startSchedulerTest } = require('./scheduler/cronTest')
const { cacheTopSymbols } = require('./utils/cache');
const { log } = require('./utils/logger');
const db = require('./db');

db.initTables(); // 初始化所有表结构

// 示例使用日志模块
db.log.insert('INFO', '策略启动完成');
// const logs = db.log.list(5);
// console.log('最近日志：', logs);
// console.log('Binance Config:', {
//   apiKey: !!config.binance.apiKey, // 只显示是否存在
//   apiSecret: !!config.binance.apiSecret
// });

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝：', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常：', err);
});

(async () => {
  try {
    log('🚀 启动自动交易策略服务...');
    await initTelegramBot();          // 初始化 TG 按钮控制
    await cacheTopSymbols();          // 启动时获取Top50币种
    await startSchedulerTest();       // 策略开始     
  } catch (error) {
    console.error('❌ 启动失败:', error.message);
  }
})();