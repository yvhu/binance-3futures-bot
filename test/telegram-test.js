// 测试脚本（不依赖主项目）
const { sendTelegramMessage } = require('../telegram/bot');
const config = require('../config/config');

(async () => {
  try {
    console.log('=== 开始Telegram消息测试 ===');
    
    // 测试1：发送简单文本
    await sendTelegramMessage('🔧 测试消息: 基础功能验证');
    console.log('✅ 测试消息1发送成功');

    // 测试2：发送长文本+特殊字符
    await sendTelegramMessage(`📊 压力测试:\n${'A'.repeat(200)}\n@#$%^&*()`);
    console.log('✅ 测试消息2发送成功');

  } catch (err) {
    console.error('❌ 测试失败:', err);
  } finally {
    process.exit();
  }
})();