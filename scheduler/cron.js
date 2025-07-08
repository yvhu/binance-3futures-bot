const cron = require('node-cron');
const { runStrategyCycle } = require('../strategy/runner');
const { log } = require('../utils/logger');
const { serviceStatus } = require('../telegram/commands');

async function startScheduler() {
  cron.schedule('*/3 * * * *', async () => {
    if (serviceStatus.running) {
      log('⏱ 执行定时策略轮询...');
      await runStrategyCycle();
    }
  });
  log('✅ 定时器启动，每3分钟运行一次');
}

module.exports = { startScheduler };
