const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'telegram-test.log');

async function testTelegram() {
  // 先引入 initTelegramBot 和 sendTelegramMessage
  const { initTelegramBot, sendTelegramMessage } = require('../telegram/bot');

  const logMessage = (msg) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(line.trim());
  };

  try {
    logMessage('=== 开始测试 ===');

    // 先初始化 bot，等待完成（建立长轮询连接）
    await initTelegramBot();

    // 初始化完成后发送测试消息
    await sendTelegramMessage('🛠️ 测试消息 from standalone script');

    logMessage('✅ 消息发送成功');
  } catch (err) {
    logMessage(`❌ 测试失败: ${err.message}`);
  }
}

testTelegram();
