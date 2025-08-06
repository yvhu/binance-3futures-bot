const { placeOrder, getLossIncomes, cleanUpOrphanedOrders, placeOrderTest, placeOrderTestNew } = require('../binance/trade');



async function getServerTime() {
  const response = await proxyGet(`${BINANCE_API}/fapi/v1/time`);
  return response.data.serverTime;
}

async function testOrder() {
    try {
        logMessage('=== 开始测试 ===');
        const timestamp = await getServerTime();
        
        await placeOrderTestNew(null, 'BTC', 'BUY')

        logMessage('✅ 消息发送成功');
    } catch (err) {
        logMessage(`❌ 测试失败: ${err.message}`);
    }
}

testOrder();