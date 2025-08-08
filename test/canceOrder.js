const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, 'cancelOrder.log');
const { cancelOrder } = require('../binance/trade');

async function testCancelOrderr() {
    const logMessage = (msg) => {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${msg}\n`;
        fs.appendFileSync(logFile, line);
        console.log(line.trim());
    };

    try {
        logMessage('=== 开始测试 ===');

        const orderResult = await cancelOrder('SOLUSDT', '134808417586');
        log('orderResult keys:', Object.keys(orderResult || {}));
        log('orderResult instanceof Error?', orderResult instanceof Error);
        log('orderResult.status:', orderResult?.status);
        log('orderResult.data:', JSON.stringify(orderResult?.data, null, 2));
        log('orderResult.response?.data:', JSON.stringify(orderResult?.response?.data, null, 2));

        logMessage('✅ 消息发送成功');
    } catch (err) {
        logMessage(`❌ 测试失败: ${err.message}`);
        logMessage('取消委托失败error:', JSON.stringify(error, null, 2));
    }
}

testCancelOrderr();