const axios = require('axios');
const config = require('../config/config');
const { sendTelegramMessage } = require('../telegram/bot');
const { log } = require('../utils/logger');
const crypto = require('crypto');

// Binance 合约API基础地址，从配置读取
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';

// 简单持仓记录（内存缓存），生产环境建议持久化数据库
const POSITION_DB = {};

/**
 * 获取币种当前市场价格（USDT合约）
 * @param {string} symbol 交易对，如 BTCUSDT
 * @returns {number} 当前最新成交价
 */
async function getCurrentPrice(symbol) {
  const url = `${BINANCE_API}/fapi/v1/ticker/price?symbol=${symbol}`;
  const res = await axios.get(url);
  return parseFloat(res.data.price);
}

/**
 * 计算可下单数量（合约张数）
 * 使用当前账户USDT余额 * 杠杆 * 配置比例计算
 * @param {string} symbol 交易对
 * @param {number} price 当前价格
 * @returns {number} 下单数量（张数，保留3位小数）
 */
async function calcOrderQty(symbol, price) {
  // 获取账户USDT可用余额
  const usdtBalance = await getUSDTBalance();
  const totalUSDT = usdtBalance * config.positionRatio; // 例如全仓为1.0
  // 计算合约张数 = (USDT金额 * 杠杆) / 当前价格
  const qty = (totalUSDT * config.leverage) / price;
  return parseFloat(qty.toFixed(3));
}

/**
 * 获取账户USDT可用余额
 * 需要币安合约账户权限，使用签名接口
 */
async function getUSDTBalance() {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${BINANCE_API}/fapi/v2/account?${queryString}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };
  const res = await axios.get(url, { headers });

  // 查询USDT资产余额
  const usdtAsset = res.data.assets.find(a => a.asset === 'USDT');
  if (!usdtAsset) throw new Error('无法获取USDT余额');
  return parseFloat(usdtAsset.availableBalance);
}

/**
 * 市价下单接口（全仓操作）
 * @param {string} symbol 交易对，例如 BTCUSDT
 * @param {string} side 买入BUY 或 卖出SELL
 */
async function placeOrder(symbol, side = 'BUY') {
  const price = await getCurrentPrice(symbol);
  const qty = await calcOrderQty(symbol, price);
  const timestamp = Date.now();

  // 组装请求参数
  const data = new URLSearchParams({
    symbol,
    side,
    type: 'MARKET',
    quantity: qty,
    timestamp: timestamp.toString()
  });

  // 生成签名
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(data.toString())
    .digest('hex');

  const finalUrl = `${BINANCE_API}/fapi/v1/order?${data.toString()}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

  try {
    // 发送下单请求
    const res = await axios.post(finalUrl, null, { headers });

    // 记录持仓时间和方向（买多/卖空）
    POSITION_DB[symbol] = {
      time: Date.now(),
      side
    };

    log(`📥 下单成功 ${side} ${symbol}, 数量: ${qty}`);
    await sendTelegramMessage(`✅ 下单成功：${side} ${symbol} 数量: ${qty}，价格: ${price}`);
    return res.data;
  } catch (err) {
    log(`❌ 下单失败 ${side} ${symbol}:`, err.response?.data || err.message);
    await sendTelegramMessage(`❌ 下单失败：${side} ${symbol}，原因: ${err.response?.data?.msg || err.message}`);
    throw err;
  }
}

/**
 * 判断是否需要自动平仓（根据持仓时间）
 * 超过配置时间则强制平仓
 * @param {string} symbol 交易对
 */
async function closePositionIfNeeded(symbol) {
  const position = POSITION_DB[symbol];
  if (!position) {
    log(`⚠️ ${symbol} 无持仓记录，无需平仓`);
    return;
  }

  const now = Date.now();
  const heldMinutes = (now - position.time) / 60000;

  if (heldMinutes >= config.maxPositionMinutes) {
    // 平仓方向与持仓方向相反
    const side = position.side === 'BUY' ? 'SELL' : 'BUY';
    const price = await getCurrentPrice(symbol);

    log(`🧯 ${symbol} 持仓超过 ${config.maxPositionMinutes} 分钟，自动平仓 ${side}`);
    await sendTelegramMessage(`⚠️ ${symbol} 超时平仓：${side} @ 价格 ${price}`);

    // 下市价单平仓
    try {
      const timestamp = Date.now();
      const qty = await calcOrderQty(symbol, price);
      const data = new URLSearchParams({
        symbol,
        side,
        type: 'MARKET',
        quantity: qty,
        timestamp: timestamp.toString()
      });
      const signature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(data.toString())
        .digest('hex');

      const finalUrl = `${BINANCE_API}/fapi/v1/order?${data.toString()}&signature=${signature}`;
      const headers = { 'X-MBX-APIKEY': config.binance.apiKey };
      await axios.post(finalUrl, null, { headers });

      delete POSITION_DB[symbol]; // 清理持仓缓存
      log(`✅ ${symbol} 平仓成功`);
      await sendTelegramMessage(`✅ ${symbol} 超时平仓成功`);
    } catch (err) {
      log(`❌ ${symbol} 平仓失败:`, err.response?.data || err.message);
      await sendTelegramMessage(`❌ ${symbol} 平仓失败，原因：${err.response?.data?.msg || err.message}`);
    }
  } else {
    log(`ℹ️ ${symbol} 持仓时长 ${heldMinutes.toFixed(1)} 分钟，未达到最大持仓时间`);
  }
}

module.exports = {
  placeOrder,
  closePositionIfNeeded,
  getCurrentPrice
};
