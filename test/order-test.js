const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, 'order-test.log');
const { placeOrder, getLossIncomes, cleanUpOrphanedOrders, placeOrderTestNew } = require('../binance/trade');

async function testOrder() {
    const logMessage = (msg) => {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${msg}\n`;
        fs.appendFileSync(logFile, line);
        console.log(line.trim());
    };

    try {
        logMessage('=== 开始测试 ===');

        await placeOrderTestNew(null, '1000SHIBUSDT', 'BUY')

        logMessage('✅ 消息发送成功');
    } catch (err) {
        logMessage(`❌ 测试失败: ${err.message}`);
    }
}

testOrder();