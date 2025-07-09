// 测试脚本（不依赖主项目）
const fs = require('fs');
const path = require('path');

// 日志文件路径
const logFile = path.join(__dirname, 'telegram-test.log');

async function testTelegram() {
  const { sendTelegramMessage } = require('../telegram/bot');
  
  const logMessage = (msg) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(line.trim());
  };

  try {
    logMessage('=== 开始测试 ===');
    try {
        await sendTelegramMessage('🛠️ 测试消息 from standalone script');
    } catch (error) {
        logMessage(`❌ 测试失败: ${error.message}`);
    }
    logMessage('✅ 消息发送成功');
  } catch (err) {
    logMessage(`❌ 测试失败: ${err.message}`);
  }
}

testTelegram();