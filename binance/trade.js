const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const config = require('../config/config');
const { sendTelegramMessage } = require('../telegram/messenger');
const { log } = require('../utils/logger');
const crypto = require('crypto');
const { getSymbolPrecision } = require('../utils/cache');
const { shouldCloseByExitSignal } = require('../indicators/analyzer');
const { getPosition, setPosition, removePosition, hasPosition } = require('../utils/position');
const { getCurrentPrice } = require('./market');
const { getCachedPositionRatio } = require('../utils/cache');
const { getOrderMode } = require('../utils/state');
// === 止损参数配置 ===
const { enableStopLoss, stopLossRate, enableTakeProfit, takeProfitRate } = config.riskControl;


// Binance 合约API基础地址，从配置读取
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';

/**
 * 计算下单数量，根据配置选择按比例或固定金额下单
 * - 若为固定金额，默认10U，不足则不下单
 * @param {string} symbol 币种，如 BTCUSDT
 * @param {number} price 当前市价
 * @returns {number} 可下单数量（处理过精度），不足最小值返回 0
 */
async function calcOrderQty(symbol, price) {
  const mode = getOrderMode(); // 默认为比例模式
  const leverage = config.leverage || 10;

  let usdtBalance = await getUSDTBalance(); // 当前总余额
  let usdtAmount = 0;

  if (mode === 'amount') {
    // ===== 固定金额模式 =====
    const fixedAmount = config.fixedAmountUSDT || 10;

    if (usdtBalance < fixedAmount) {
      log(`❌ 余额不足固定下单金额：${usdtBalance} < ${fixedAmount}，跳过下单`);
      return 0;
    }

    usdtAmount = fixedAmount;
    log(`📌 使用固定金额模式下单：${fixedAmount} USDT`);
  } else {
    // ===== 比例模式 =====
    const cachedRatio = getCachedPositionRatio();
    const ratio = cachedRatio !== null ? cachedRatio : config.positionRatio || 1;
    usdtAmount = usdtBalance * ratio;
    log(`📌 使用比例下单模式：余额=${usdtBalance}，比例=${ratio * 100}% → 金额=${usdtAmount.toFixed(2)} USDT`);
  }

  // === 计算原始张数（未处理精度）===
  let rawQty = (usdtAmount * leverage) / price;

  // === 获取币种精度信息 ===
  const precision = getSymbolPrecision(symbol);
  if (!precision) {
    throw new Error(`❌ 无法获取 ${symbol} 精度信息`);
  }

  const qtyPrecision = precision.quantityPrecision;
  const minQty = precision.minQty || 0;

  // === 四舍五入保留精度 ===
  const fixedQty = parseFloat(rawQty.toFixed(qtyPrecision));

  // === 检查是否满足最小下单数量 ===
  if (fixedQty <= 0 || (minQty && fixedQty < minQty)) {
    log(`❌ 数量过小：${fixedQty} < 最小值${minQty}`);
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
  const res = await proxyGet(url, { headers });

  // 查询USDT资产余额
  const usdtAsset = res.data.assets.find(a => a.asset === 'USDT');
  if (!usdtAsset) throw new Error('无法获取USDT余额');
  return parseFloat(usdtAsset.availableBalance);
}

/**
 * 设置杠杆倍数
 * @param {string} symbol 交易对，例如 BTCUSDT
 * @param {string} leverage 
 */
async function setLeverage(symbol, leverage) {
  const timestamp = Date.now();
  const params = new URLSearchParams({
    symbol,
    leverage: leverage.toString(),
    timestamp: timestamp.toString()
  });
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(params.toString())
    .digest('hex');
  const url = `${BINANCE_API}/fapi/v1/leverage?${params.toString()}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };
  try {
    const res = await proxyPost(url, null, { headers });
    log(`✅ 设置杠杆成功 ${symbol}：${leverage}x`);
    return res.data;
  } catch (err) {
    log(`❌ 设置杠杆失败 ${symbol}:`, err.response?.data || err.message);
    throw err;
  }
}

// 撤销 symbol 上所有 STOP_MARKET 类型的订单
async function cancelAllOpenStopOrders(symbol) {
  try {
    const timestamp = Date.now();
    const url = `${BINANCE_API}/fapi/v1/openOrders?symbol=${symbol}&timestamp=${timestamp}`;
    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(`symbol=${symbol}&timestamp=${timestamp}`)
      .digest('hex');

    const finalUrl = `${url}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

    const res = await proxyGet(finalUrl, { headers });
    const openOrders = res.data || [];

    const stopOrders = openOrders.filter(o => o.type === 'STOP_MARKET');

    for (const order of stopOrders) {
      const cancelUrl = `${BINANCE_API}/fapi/v1/order?symbol=${symbol}&orderId=${order.orderId}&timestamp=${Date.now()}`;
      const cancelSignature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(`symbol=${symbol}&orderId=${order.orderId}&timestamp=${Date.now()}`)
        .digest('hex');

      const cancelFinalUrl = `${cancelUrl}&signature=${cancelSignature}`;
      await proxyDelete(cancelFinalUrl, { headers });

      log(`🗑 已撤销止损单：${symbol} - ID ${order.orderId}`);
    }

  } catch (err) {
    log(`❌ 撤销止损单失败 ${symbol}: ${err.message}`);
    sendTelegramMessage(`⚠️ 撤销止损单失败 ${symbol}，请手动检查`);
  }
}

/**
 * 市价下单接口（全仓操作）
 * @param {string} symbol 交易对，例如 BTCUSDT
 * @param {string} side 买入BUY 或 卖出SELL
 */
async function placeOrder(symbol, side = 'BUY', positionAmt) {
  const price = await getCurrentPrice(symbol); // 当前市价
  await setLeverage(symbol, config.leverage); // 👈 设置杠杆，重复设置也不会报错
  log(`📥 是否平仓：${positionAmt ? '是' : '否'}, 数量: ${positionAmt ? positionAmt : 0}`);

  // 计算下单数量：若传入 positionAmt 说明是平仓，否则根据可用资金计算
  const qtyRaw = positionAmt ? parseFloat(positionAmt) : await calcOrderQty(symbol, price);

  // 🧩 如果是开仓操作，且数量无效，跳过该币种下单
  if (!positionAmt && (!qtyRaw || Math.abs(qtyRaw) <= 0)) {
    log(`⚠️ ${symbol} 无法下单：数量为 0，跳过。可能因为余额不足或数量低于最小值。`);
    sendTelegramMessage(`⚠️ 跳过 ${symbol} 下单：数量为 0，可能因为余额不足或不满足最小下单量`);
    return;
  }

  // === 获取币种精度并格式化数量 ===
  const precision = getSymbolPrecision(symbol);
  if (!precision) {
    throw new Error(`找不到币种 ${symbol} 的精度信息`);
  }

  // 四舍五入到指定数量精度
  const qty = Number(qtyRaw).toFixed(precision.quantityPrecision);
  const timestamp = Date.now();

  // 构造市价单请求参数
  const data = new URLSearchParams({
    symbol,
    side,
    type: 'MARKET',
    quantity: Math.abs(qty),
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
    // === 如果是平仓操作，先撤销未完成止损单 ===
    if (positionAmt) {
      await cancelAllOpenStopOrders(symbol); // ⬅️ 需要你实现这个函数
    }

    // 执行市价下单请求
    const res = await proxyPost(finalUrl, null, { headers });
    log(`📥 下单成功 ${side} ${symbol}, 数量: ${qty}`);
    sendTelegramMessage(`✅ 下单成功：${side} ${symbol} 数量: ${qty}，价格: ${price}`);

    // === 如果是开仓，挂止损单（亏损20%止损） ===
    // === 止损参数配置 ===
    if (!positionAmt && enableStopLoss) {
      const stopSide = side === 'BUY' ? 'SELL' : 'BUY'; // 止损方向与开仓方向相反
      // 根据开仓方向计算止损触发价格，支持自定义止损比率
      const stopPrice = side === 'BUY'
        ? (price * (1 - stopLossRate)).toFixed(precision.pricePrecision)
        : (price * (1 + stopLossRate)).toFixed(precision.pricePrecision);

      const stopParams = new URLSearchParams({
        symbol,
        side: stopSide,
        type: 'STOP_MARKET',
        stopPrice: stopPrice,
        closePosition: 'true',
        timestamp: Date.now().toString()
      });

      const stopSignature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(stopParams.toString())
        .digest('hex');

      const stopUrl = `${BINANCE_API}/fapi/v1/order?${stopParams.toString()}&signature=${stopSignature}`;
      const stopRes = await proxyPost(stopUrl, null, { headers });
      log(`🛑 已设置止损单 ${symbol}，触发价: ${stopPrice}`);
      sendTelegramMessage(`📉 已挂止损单：${symbol} 方向: ${stopSide}，触发价: ${stopPrice}`);
    }

    // === 如果是开仓，挂止盈单（盈利10%止盈） ===
    if (!positionAmt && enableTakeProfit) {
      const takeProfitSide = side === 'BUY' ? 'SELL' : 'BUY'; // 止盈方向与开仓方向相反
      const takeProfitPrice = side === 'BUY'
        ? (price * (1 + takeProfitRate)).toFixed(precision.pricePrecision)
        : (price * (1 - takeProfitRate)).toFixed(precision.pricePrecision);

      const tpParams = new URLSearchParams({
        symbol,
        side: takeProfitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: takeProfitPrice,   // 虽然叫 stopPrice，其实这里是触发价
        closePosition: 'true',
        timestamp: Date.now().toString()
      });

      const tpSignature = crypto
        .createHmac('sha256', config.binance.apiSecret)
        .update(tpParams.toString())
        .digest('hex');

      const tpUrl = `${BINANCE_API}/fapi/v1/order?${tpParams.toString()}&signature=${tpSignature}`;
      const tpRes = await proxyPost(tpUrl, null, { headers });

      log(`🎯 已设置止盈单 ${symbol}，触发价: ${takeProfitPrice}`);
      sendTelegramMessage(`💰 已挂止盈单：${symbol} 方向: ${takeProfitSide}，触发价: ${takeProfitPrice}`);
    }


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
        const res = await proxyPost(finalUrl, null, { headers });
        log(`币安平仓接口响应：`, res.data);

        if (res?.status != 200) {
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

/**
 * 获取账户指定合约交易对的成交记录（userTrades）
 * @param {string} symbol 交易对，如 BTCUSDT
 * @param {number} startTime 过滤起始时间戳（毫秒）
 * @returns {Promise<Array>} 交易记录数组
 */
async function getAccountTrades(symbol, startTime = 0) {
  try {
    const timestamp = Date.now();
    const params = new URLSearchParams({
      symbol,
      timestamp: timestamp.toString(),
      limit: '20',   // 最大100条，最大可调整，币安接口限制
    });
    if (startTime > 0) {
      params.append('startTime', startTime.toString());
    }
    // 计算签名
    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(params.toString())
      .digest('hex');

    const url = `${BINANCE_API}/fapi/v1/userTrades?${params.toString()}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

    const res = await proxyGet(url, { headers });
    return res.data || [];
  } catch (error) {
    log(`❌ 获取交易记录失败 ${symbol}:`, error.response?.data || error.message);
    sendTelegramMessage(`❌ 获取交易记录失败 ${symbol}，请检查API权限或网络`);
    return [];
  }
}

module.exports = {
  placeOrder,
  closePositionIfNeeded,
  getAccountTrades
};
