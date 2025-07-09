const axios = require('axios');
const config = require('../config/config');
const { sendTelegramMessage } = require('../telegram/messenger');
const { log } = require('../utils/logger');
const crypto = require('crypto');
const { getSymbolPrecision } = require('../utils/cache');
const { shouldCloseByExitSignal } = require('../indicators/analyzer');
const { getPosition, setPosition, removePosition, hasPosition } = require('../utils/position');

// Binance 合约API基础地址，从配置读取
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';

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
  const usdtBalance = await getUSDTBalance();
  const totalUSDT = usdtBalance * config.positionRatio;
  // 计算原始张数（未处理精度）
  let rawQty = (totalUSDT * config.leverage) / price;
  // === 获取币种精度信息（pricePrecision, quantityPrecision）===
  const precision = getSymbolPrecision(symbol);
  if (!precision) {
    throw new Error(`❌ 未找到 ${symbol} 精度信息，无法计算下单数量`);
  }
  const qtyPrecision = precision.quantityPrecision;
  const minQty = precision.minQty || 0; // 可以从 cache 精度中扩展存储 minQty
  // === 按精度保留小数位 ===
  const fixedQty = parseFloat(rawQty.toFixed(qtyPrecision));
  // === 防止数量小于最小下单数量 ===
  if (fixedQty <= 0 || (minQty && fixedQty < minQty)) {
    log(`❌ 计算后数量过小: ${fixedQty}，小于最小要求`);
    return 0;
  }
  return fixedQty;
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
  const qtyRaw = await calcOrderQty(symbol, price);
  // === 获取币种精度并格式化数量 ===
  const precision = getSymbolPrecision(symbol);
  if (!precision) {
    throw new Error(`找不到币种 ${symbol} 的精度信息`);
  }
  // 四舍五入到指定数量精度
  const qty = Number(qtyRaw).toFixed(precision.quantityPrecision);
  const timestamp = Date.now();
  // 构造请求参数
  const data = new URLSearchParams({
    symbol,
    side,
    type: 'MARKET',       // 市价单
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
    // 执行下单请求
    const res = await axios.post(finalUrl, null, { headers });
    // 持仓数量带方向，买多为正，卖空为负
    const positionAmt = side === 'BUY' ? qty : -qty;
    // 记录持仓方向和时间
    setPosition(symbol, {
      time: Date.now(),
      side,
      positionAmt  // 记录持仓数量
    });
    log(`📥 下单成功 ${side} ${symbol}, 数量: ${qty}`);
    sendTelegramMessage(`✅ 下单成功：${side} ${symbol} 数量: ${qty}，价格: ${price}`);
    return res.data;
  } catch (err) {
    log(`❌ 下单失败 ${side} ${symbol}:`, err.response?.data || err.message);
    sendTelegramMessage(`❌ 下单失败：${side} ${symbol}，原因: ${err.response?.data?.msg || err.message}`);
    throw err;
  }
}

/**
 * 判断是否需要自动平仓（根据持仓时间）
 * 超过配置时间则强制平仓
 * @param {string} symbol 交易对
 */
/**
 * 检查是否需要超时平仓，如果超过 maxPositionMinutes 则自动平掉
 */
/**
 * 根据持仓情况判断是否需要平仓
 * 条件：
 *  1. 持仓时间超过配置的最大持仓时间
 *  2. 当前技术信号与持仓方向相反，出现反转信号时提前平仓
 *
 * @param {string} symbol 币种交易对，比如 'BTCUSDT'
 */
async function closePositionIfNeeded(symbol) {
  // 从本地持仓记录中获取该币种的持仓信息
  const position = getPosition(symbol);
  if (!position) {
    log(`⚠️ ${symbol} 无持仓记录，无需平仓`);
    return;
  }

  const now = Date.now();
  // 计算持仓时长（分钟）
  const heldMinutes = (now - position.time) / 60000;
  // 当前持仓方向，BUY 做多，SELL 做空
  const currentSide = position.side;

  // 是否因持仓时间超限需要平仓
  let shouldCloseByTime = heldMinutes >= config.maxPositionMinutes;
  // 是否因当前信号反向需要平仓
  let shouldCloseBySignal = false;

  try {
    // 调用策略分析函数，获取当前币种最新做多/做空信号
    const { shouldLong, shouldShort } = await shouldCloseByExitSignal(symbol, config.interval);
    log(`⚠️ ${shouldLong}、${shouldShort} 当前信号`);
    // 如果持仓是做多，但最新信号是做空，则需要平仓
    if ((currentSide === 'BUY' && shouldShort) ||
      (currentSide === 'SELL' && shouldLong)) {
      shouldCloseBySignal = true;
      log(`🔁 ${symbol} 当前信号与持仓方向相反，准备平仓`);
      sendTelegramMessage(`🔁 ${symbol} 当前信号反转，准备平仓`);
    }
  } catch (err) {
    // 信号分析失败时记录错误，但不影响平仓判断（可根据需求调整）
    log(`⚠️ ${symbol} 分析当前信号失败：${err.message}`);
  }

  // 满足持仓时间超限或信号反转任一条件则执行平仓操作
  if (shouldCloseByTime || shouldCloseBySignal) {
    // 平仓方向与当前持仓相反
    const exitSide = currentSide === 'BUY' ? 'SELL' : 'BUY';
    // 获取当前最新价格
    const price = await getCurrentPrice(symbol);
    log(`🧯 ${symbol} 满足平仓条件，自动平仓 ${exitSide} @ ${price}`);
    sendTelegramMessage(`⚠️ ${symbol} 触发平仓：${exitSide} @ 价格 ${price}`);
    log(`开始自动平仓`);
    try {
      const timestamp = Date.now();
      // 获取该交易对的数量精度，用于下单数量四舍五入
      // const precision = getSymbolPrecision(symbol);
      // if (!precision) throw new Error(`未找到 ${symbol} 精度信息`);

      // 计算下单数量（注意应根据仓位大小和价格计算）
      // const qtyRaw = await calcOrderQty(symbol, price);
      // 保留数量精度（数量是浮点数）
      // const qty = parseFloat(qtyRaw.toFixed(precision.quantityPrecision));

      // 构造币安合约下单请求参数（市价单）
      const data = new URLSearchParams({
        symbol,
        side: exitSide,
        type: 'MARKET',
        quantity: Math.abs(position.positionAmt),
        timestamp: timestamp.toString(),
        reduceOnly: 'true',       // 关键参数，确保只减少持仓
      });

      // 签名生成
      const signature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(data.toString())
        .digest('hex');

      // 请求 URL
      const finalUrl = `${BINANCE_API}/fapi/v1/order?${data.toString()}&signature=${signature}`;
      const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

      // 发送下单请求
      try {
        const res = await axios.post(finalUrl, null, { headers });
        log(`币安平仓接口响应：`, res.data);

        if (res.data.status !== 'FILLED' && parseFloat(res.data.executedQty) === 0) {
          log(`⚠️ 订单未完全成交，状态: ${res.data.status}`);
          sendTelegramMessage(`⚠️ ${symbol} 平仓订单未成交，状态: ${res.data.status}，订单：${res.data.executedQty}，请手动确认`);
          return;  // 不清理本地持仓，等待后续成交或人工处理
        }

        // 订单成交成功
        removePosition(symbol);
        log(`✅ ${symbol} 平仓成功`);
        sendTelegramMessage(`✅ ${symbol} 平仓成功`);
      } catch (err) {
        log(`❌ ${symbol} 平仓失败:`, err.response?.data || err.message);
        sendTelegramMessage(`❌ ${symbol} 平仓失败，原因：${err.response?.data?.msg || err.message}`);
      }

    } catch (err) {
      // 下单失败，记录错误并通知
      log(`❌ ${symbol} 平仓失败:`, err.response?.data || err.message);
      sendTelegramMessage(`❌ ${symbol} 平仓失败，原因：${err.response?.data?.msg || err.message}`);
    }
  } else {
    // 不满足平仓条件，输出当前持仓时间信息
    log(`ℹ️ ${symbol} 持仓 ${heldMinutes.toFixed(1)} 分钟，未达平仓条件`);
  }
}

module.exports = {
  placeOrder,
  closePositionIfNeeded,
  getCurrentPrice
};
