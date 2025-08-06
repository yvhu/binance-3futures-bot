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
const { db, trade } = require('../db');
const _ = require('lodash');
const moment = require('moment-timezone');
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
  // const mode = getOrderMode(); // 默认为比例模式
  const mode = 'amount';
  const leverage = config.leverage || 10;

  // let usdtBalance = await getUSDTBalance(); // 当前总余额
  let usdtBalance = 100000000;
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
  const timestamp = await getServerTime();
  log('✅ 获取系统时间');
  const localTime = Date.now();
  log("服务器时间:", timestamp, "本地时间:", localTime, "差值:", localTime - timestamp);
  const params = new URLSearchParams({
    symbol,
    leverage: leverage.toString(),
    timestamp: localTime.toString()
  });
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret.trim()) // 同样trim()处理
    .update(params.toString())
    .digest('hex');
  // 检查你的 config.binance 配置是否正确
  console.log(`打印杠杆倍数：${config.leverage}`);
  console.log(`apiKey: ${config.binance.apiKey}`); // 应该显示你的有效API密钥
  console.log(`apiSecret: ${config.binance.apiSecret}`); // 应该显示你的有效API密钥 secret
  console.log('生成的签名:', signature); // 调试输出
  const url = `${BINANCE_API}/fapi/v1/leverage?${params.toString()}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey.trim() };
  try {
    console.log('打印参数url:', url); // 调试输出
    console.log('打印参数headers:', headers); // 调试输出
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

      // 计算收益率（亏损比例）
      const profitLossRate = side === 'BUY'
        ? ((stopPrice / price - 1) * 100 * 10).toFixed(2) + '%'  // 做多止损：亏损比例
        : ((1 - stopPrice / price) * 100 * 10).toFixed(2) + '%'; // 做空止损：亏损比例

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
      sendTelegramMessage(`📉 止损挂单：${symbol} | 方向: ${stopSide} | 触发价: ${stopPrice} | 预计亏损: ${profitLossRate}`);
    }

    // === 如果是开仓，挂止盈单（盈利10%止盈） ===
    if (!positionAmt && enableTakeProfit) {
      const takeProfitSide = side === 'BUY' ? 'SELL' : 'BUY'; // 止盈方向与开仓方向相反
      const takeProfitPrice = side === 'BUY'
        ? (price * (1 + takeProfitRate)).toFixed(precision.pricePrecision)
        : (price * (1 - takeProfitRate)).toFixed(precision.pricePrecision);

      // 计算收益率（盈利比例）
      const profitRate = side === 'BUY'
        ? ((takeProfitPrice / price - 1) * 100 * 10).toFixed(2) + '%'  // 做多止盈：盈利比例
        : ((1 - takeProfitPrice / price) * 100 * 10).toFixed(2) + '%'; // 做空止盈：盈利比例

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
      sendTelegramMessage(`💰 止盈挂单：${symbol} | 方向: ${takeProfitSide} | 触发价: ${takeProfitPrice} | 预计盈利: ${profitRate}`);
    }


    return res.data;

  } catch (err) {
    log(`❌ 下单失败 ${side} ${symbol}:`, err.response?.data || err.message);
    sendTelegramMessage(`❌ 下单失败：${side} ${symbol}，原因: ${err.response?.data?.msg || err.message}`);
    throw err;
  }
}

// 获取指定币种的 K 线数据（默认获取 50 根）
async function fetchKlines(symbol, interval, limit = 2) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    openTime: k[0],
    open: k[1], // 保持字符串形式
    high: k[2], // 保持字符串形式
    low: k[3],  // 保持字符串形式
    close: k[4], // 保持字符串形式
    volume: k[5] // 保持字符串形式
  }));
}

async function getServerTime() {
  const response = await proxyGet(`${BINANCE_API}/fapi/v1/time`);
  return response.data.serverTime;
}

async function placeOrderTest(tradeId, symbol, side = 'BUY', positionAmt) {
  const price = await getCurrentPrice(symbol); // 当前市价
  // await setLeverage(symbol, config.leverage);

  // 计算下单数量
  const qtyRaw = positionAmt ? parseFloat(positionAmt) : await calcOrderQty(symbol, price);
  log(`✅ symbol: ${symbol} ${side} ID:${tradeId} 开平仓:${positionAmt ? '平仓' : '开仓'}`);
  if (positionAmt) {
    // 平仓逻辑
    try {
      // 1. 获取原始交易信息
      const originalTrade = trade.getTradeById(db, tradeId);
      if (!originalTrade) {
        throw new Error(`未找到交易记录: ${tradeId}`);
      }

      // 2. 获取当前K线数据（3分钟）
      const klineData = await fetchKlines(symbol, config.interval);
      const { openTime, open, high, low, close, volume } = klineData[1];
      log(`✅ 获取平仓K线信息: ${symbol} openTime：${new Date(openTime).toISOString()} open:${open} high:${high} low:${low} close:${close} volume: ${volume}`);

      // 3. 执行平仓（带K线数据）
      const success = trade.closeTrade(db, tradeId, price, Number(high), Number(low), openTime);
      if (!success) {
        throw new Error('平仓操作失败');
      }

      // 4. 获取更新后的交易信息
      const closedTrade = trade.getTradeById(db, tradeId);

      // 5. 准备通知消息（可包含K线信息）
      const message = formatTradeNotification(closedTrade);

      // 6. 发送通知
      await sendNotification(message);

      log(`✅ 平仓成功: ${symbol} ${side} 数量:${qtyRaw} 价格:${price}`);
      return closedTrade;

    } catch (err) {
      log(`❌ 平仓失败: ${symbol} ${side}, 原因: ${err.message}`);
      throw err;
    }
  } else {
    // 开仓逻辑
    try {
      const tradeId = trade.recordTrade(db, {
        symbol: symbol,
        price: price,
        qtyRaw: qtyRaw,
        side: side
      });

      log(`✅ 开仓成功: ${symbol} ${side} 数量:${qtyRaw} 价格:${price} 交易ID:${tradeId}`);
      return { tradeId, symbol, price, qtyRaw, side };

    } catch (err) {
      log(`❌ 开仓失败: ${symbol} ${side}, 原因: ${err.message}`);
      throw err;
    }
  }
}

/**
 * 格式化交易通知消息
 * @param {Object} trade 交易记录
 * @returns {string} 格式化后的消息
 */
function formatTradeNotification(trade) {
  const entryTime = new Date(trade.entry_time).toLocaleString();
  const exitTime = trade.exit_time ? new Date(trade.exit_time).toLocaleString() : '未平仓';
  const leverage = config.leverage || 10; // 10倍杠杆

  // 计算杠杆收益率
  let longHighROI = 0;
  let longLowROI = 0;
  let shortHighROI = 0;
  let shortLowROI = 0;

  if (trade.kline_high && trade.kline_low) {
    // 做多情况下
    if (trade.side === 'BUY') {
      // 最高点收益率 (10倍杠杆)
      longHighROI = ((trade.kline_high - trade.entry_price) / trade.entry_price) * leverage * 100;
      // 最低点收益率 (10倍杠杆)
      longLowROI = ((trade.kline_low - trade.entry_price) / trade.entry_price) * leverage * 100;
    }
    // 做空情况下
    else {
      // 最高点收益率 (10倍杠杆)
      shortHighROI = ((trade.entry_price - trade.kline_high) / trade.entry_price) * leverage * 100;
      // 最低点收益率 (10倍杠杆)
      shortLowROI = ((trade.entry_price - trade.kline_low) / trade.entry_price) * leverage * 100;
    }
  }

  return `
📊 交易结算通知
──────────────
币种: ${trade.symbol}
方向: ${trade.side === 'BUY' ? '做多' : '做空'} (${leverage}倍杠杆)
开仓时间: ${entryTime}
开仓价格: ${trade.entry_price.toFixed(4)}
平仓时间: ${exitTime}
平仓价格: ${trade.exit_price?.toFixed(4) || 'N/A'}
K线时间: ${trade.kline_time ? new Date(trade.kline_time).toLocaleString() : 'N/A'}
K线最高: ${trade.kline_high?.toFixed(4) || 'N/A'}
K线最低: ${trade.kline_low?.toFixed(4) || 'N/A'}
持仓数量: ${trade.quantity.toFixed(4)}
──────────────
${trade.side === 'BUY' ? `
做多潜在收益率(10倍杠杆):
↑ 最高点收益率: ${longHighROI.toFixed(2)}%
↓ 最低点收益率: ${longLowROI.toFixed(2)}%
` : `
做空潜在收益率(10倍杠杆):
↑ 最高点收益率: ${shortHighROI.toFixed(2)}%
↓ 最低点收益率: ${shortLowROI.toFixed(2)}%
`}
──────────────
实际盈亏金额: ${trade.profit?.toFixed(4) || '0.0000'} USDT
实际收益率: ${calculateROI(trade).toFixed(2)}%
──────────────`.trim();
}

/**
 * 计算收益率
 * @param {Object} trade 交易记录
 * @returns {number} 收益率(百分比)
 */
function calculateROI(trade) {
  if (!trade.profit || !trade.order_amount) return 0;
  return (trade.profit / trade.order_amount) * 100;
}

/**
 * 发送通知
 * @param {string} message 消息内容
 */
async function sendNotification(message) {
  // 这里实现您的通知逻辑，可以是:
  // 1. 发送到Telegram
  // 2. 发送到Slack
  // 3. 发送邮件
  // 4. 写入日志文件
  // 示例:
  await sendTelegramMessage(message);
  // console.log('发送通知:', message);
}

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

/**
 * 获取某个合约币种在指定时间段的亏损平仓记录
 * @param {string} symbol - 合约币种，例如 BTCUSDT
 * @param {number} startTime - 开始时间戳（毫秒）
 * @param {number} endTime - 结束时间戳（毫秒）
 * @returns {Promise<Array>} 亏损平仓记录数组
 */
async function getLossIncomes(symbol, startTime, endTime) {
  try {
    const timestamp = Date.now();

    const params = new URLSearchParams({
      symbol,
      incomeType: 'REALIZED_PNL',
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      limit: '100',
      timestamp: timestamp.toString(),
    });

    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(params.toString())
      .digest('hex');

    const url = `${BINANCE_API}/fapi/v1/income?${params.toString()}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

    const res = await proxyGet(url, { headers });

    if (!Array.isArray(res.data)) {
      log(`❌ ${symbol} 收益记录格式异常`);
      return [];
    }

    // 筛选出亏损的记录（income < 0）
    return res.data.filter(item => parseFloat(item.income) < 0);
  } catch (error) {
    log(`❌ 获取 ${symbol} 收益记录失败:`, error.response?.data || error.message);
    await sendTelegramMessage(`❌ 获取 ${symbol} 收益记录失败，请检查API权限或网络`);
    return [];
  }
}



/**
 * 清理无效订单并确保每个币种只有最新的止盈止损单
 */
async function cleanUpOrphanedOrders() {
  try {
    await sendTelegramMessage(`⚠️ 30min开始清理无效订单`);
    // 1. 获取所有持仓
    const positions = await fetchAllPositions();

    // 2. 获取所有活跃订单
    const allOpenOrders = await fetchAllOpenOrders();

    // 3. 按交易对分组处理
    const symbols = _.union(
      positions.map(p => p.symbol),
      allOpenOrders.map(o => o.symbol)
    ).filter(Boolean);

    for (const symbol of symbols) {
      try {
        // 4. 处理每个交易对
        await processSymbolOrders(symbol, positions, allOpenOrders);
      } catch (err) {
        log(`❌ ${symbol} 订单清理失败: ${err.message}`);
      }
    }
  } catch (error) {
    log(`❌ 订单清理全局错误: ${error.message}`);
  }
}

/**
 * 处理单个交易对的订单清理
 */
async function processSymbolOrders(symbol, allPositions, allOpenOrders) {
  // 1. 获取该交易对的持仓和订单
  const position = allPositions.find(p => p.symbol === symbol);
  const symbolOrders = allOpenOrders.filter(o => o.symbol === symbol);

  // 2. 筛选出止盈止损单
  const stopOrders = symbolOrders.filter(o =>
    ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(o.type)
  );

  // 3. 如果没有持仓，撤销所有止盈止损单
  if (!position || Number(position.positionAmt) === 0) {
    await cancelAllStopOrders(symbol, stopOrders);
    await sendTelegramMessage(`⚠️ 清理${symbol}止盈止损无效订单`);
    return;
  }

  // 4. 按类型分组（止盈/止损）
  const ordersByType = _.groupBy(stopOrders, 'type');

  // 5. 处理每种订单类型
  for (const [orderType, orders] of Object.entries(ordersByType)) {
    // 5.1 按时间降序排序
    const sortedOrders = _.orderBy(orders, ['time'], ['desc']);

    // 5.2 保留最新的一个，撤销其他的
    if (sortedOrders.length > 1) {
      const ordersToCancel = sortedOrders.slice(1);
      await cancelOrders(symbol, ordersToCancel);
      log(`✅ ${symbol} 保留最新${orderType}订单，撤销${ordersToCancel.length}个旧订单`);
      await sendTelegramMessage(`⚠️ 清理${symbol}止盈止损旧订单`);
    }
  }
}

/**
 * 撤销所有止盈止损单（无持仓时调用）
 */
async function cancelAllStopOrders(symbol, orders) {
  if (orders.length === 0) return;

  const canceledIds = [];
  for (const order of orders) {
    try {
      await cancelOrder(symbol, order.orderId);
      canceledIds.push(order.orderId);
    } catch (error) {
      log(`❌ ${symbol} 订单${order.orderId}撤销失败: ${error.message}`);
    }
  }

  if (canceledIds.length > 0) {
    log(`✅ ${symbol} 无持仓，已撤销${canceledIds.length}个止盈止损单`);
  }
}

/**
 * 批量撤销订单
 */
async function cancelOrders(symbol, orders) {
  if (orders.length === 0) return;

  // 币安批量撤销API最多支持10个订单
  const chunks = _.chunk(orders, 10);

  for (const chunk of chunks) {
    try {
      await batchCancelOrders(
        symbol,
        chunk.map(o => o.orderId)
      );
    } catch (error) {
      log(`❌ ${symbol} 批量撤销失败，尝试单个撤销: ${error.message}`);
      // 批量失败时回退到单个撤销
      for (const order of chunk) {
        await cancelOrder(symbol, order.orderId).catch(e => {
          log(`❌ ${symbol} 订单${order.orderId}撤销失败: ${e.message}`);
        });
      }
    }
  }
}

// ========== 基础API封装 ==========
async function fetchAllPositions() {
  const params = new URLSearchParams({ timestamp: Date.now() });
  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v2/positionRisk?${params}&signature=${signature}`;
  const res = await proxyGet(url);
  return res.data.filter(p => Math.abs(Number(p.positionAmt)) > 0);
}

async function fetchAllOpenOrders() {
  const params = new URLSearchParams({ timestamp: Date.now() });
  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v1/openOrders?${params}&signature=${signature}`;
  const res = await proxyGet(url);
  return res.data;
}

async function cancelOrder(symbol, orderId) {
  log(`✅ 撤销${symbol} 单号：${orderId} 止盈止损订单`);
  const params = new URLSearchParams({
    symbol,
    orderId,
    timestamp: Date.now()
  });
  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v1/order?${params}&signature=${signature}`;
  return proxyDelete(url);
}

async function batchCancelOrders(symbol, orderIds) {
  const params = new URLSearchParams({
    symbol,
    timestamp: Date.now()
  });
  orderIds.forEach((id, i) => params.append(`orderIdList[${i}]`, id));

  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v1/batchOrders?${params}&signature=${signature}`;
  return proxyDelete(url);
}

function signParams(params) {
  return crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(params.toString())
    .digest('hex');
}



// -----------新完整结构------------


async function placeOrderTestNew(tradeId, symbol, side = 'BUY', positionAmt) {
  try {
    log('✅ 下单流程开始');
    const price = await getCurrentPrice(symbol);
    log('✅ 获取价格');
    const timestamp = await getServerTime();
    log('✅ 获取系统时间');
    const localTime = Date.now();
    log("服务器时间:", timestamp, "本地时间:", localTime, "差值:", localTime - timestamp);
    await setLeverage(symbol, config.leverage);

    const qtyRaw = positionAmt ? parseFloat(positionAmt) : await calcOrderQty(symbol, price);
    log(`✅ symbol: ${symbol} ${side} ID:${tradeId} 开平仓:${positionAmt ? '平仓' : '开仓'}`);

    if (!positionAmt && (!qtyRaw || Math.abs(qtyRaw) <= 0)) {
      log(`⚠️ ${symbol} 无法下单：数量为 0，跳过。可能因为余额不足或数量低于最小值。`);
      sendTelegramMessage(`⚠️ 跳过 ${symbol} 下单：数量为 0，可能因为余额不足或不满足最小下单量`);
      return;
    }

    const precision = getSymbolPrecision(symbol);
    if (!precision) {
      throw new Error(`找不到币种 ${symbol} 的精度信息`);
    }

    const qty = Number(qtyRaw).toFixed(precision.quantityPrecision);
    const data = new URLSearchParams({
      symbol,
      side,
      type: 'MARKET',
      quantity: Math.abs(qty),
      timestamp: localTime.toString()
    });

    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(data.toString())
      .digest('hex');

    const finalUrl = `${BINANCE_API}/fapi/v1/order?${data.toString()}&signature=${signature}`;
    const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

    // 执行下单操作并捕获可能的错误
    let orderResult;
    try {
      log(positionAmt ? `📥 平仓下单开始` : `📥 开仓下单开始`);
      log(`finalUrl: ${finalUrl} `);
      orderResult = await proxyPost(finalUrl, null, { headers });
      log(`📥 下单请求已发送 ${side} ${symbol}, 数量: ${qty}`);
    } catch (orderError) {
      log(`⚠️ 下单请求失败: ${symbol} ${side}, 原因: ${orderError.message}`);
      // 继续执行后续逻辑，不抛出错误
      orderResult = null;
    }

    if (positionAmt) {
      // 平仓逻辑
      return await handleClosePosition(tradeId, symbol, side, qty, price, orderResult);
    } else {
      // 开仓逻辑
      return await handleOpenPosition(tradeId, symbol, side, qty, qtyRaw, price, localTime, precision, orderResult);
    }
  } catch (error) {
    log(`❌ 下单流程出现异常: ${symbol} ${side}, 原因: ${error.message}`);
    throw error;
  }
}

async function handleClosePosition(tradeId, symbol, side, qty, price, orderResult) {
  try {
    if (orderResult) {
      sendTelegramMessage(`✅ 平仓下单成功：${side} ${symbol} 数量: ${qty}，价格: ${price}`);
    }

    // 1. 获取原始交易信息
    const originalTrade = trade.getTradeById(db, tradeId);
    if (!originalTrade) {
      throw new Error(`未找到交易记录: ${tradeId}`);
    }

    // 2. 获取当前K线数据（3分钟）
    const klineData = await fetchKlines(symbol, config.interval);
    const { openTime, open, high, low, close, volume } = klineData[1];
    log(`✅ 获取平仓K线信息: ${symbol} openTime：${new Date(openTime).toISOString()} open:${open} high:${high} low:${low} close:${close} volume: ${volume}`);

    // 3. 执行平仓（带K线数据）
    const success = trade.closeTrade(db, tradeId, price, Number(high), Number(low), openTime);
    if (!success) {
      throw new Error('平仓操作失败');
    }

    // 4. 获取更新后的交易信息
    const closedTrade = trade.getTradeById(db, tradeId);

    // 5. 准备通知消息（可包含K线信息）
    const message = formatTradeNotification(closedTrade);

    // 6. 撤单止盈止损订单
    await cancelOrder(symbol, orderResult.orderId)

    // 7. 发送通知
    await sendNotification(message);

    log(`✅ 平仓处理完成: ${symbol} ${side} 数量:${qty} 价格:${price}`);
    return closedTrade;
  } catch (err) {
    log(`❌ 平仓处理失败: ${symbol} ${side}, 原因: ${err.message}`);
    throw err;
  }
}

function isInTradingTimeRange(timeRanges) {
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTime = currentHours * 100 + currentMinutes; // 转换为数字便于比较 如0930

  return timeRanges.some(range => {
    const [startHour, startMinute] = range.start.split(':').map(Number);
    const [endHour, endMinute] = range.end.split(':').map(Number);

    const startTime = startHour * 100 + startMinute;
    const endTime = endHour * 100 + endMinute;

    return currentTime >= startTime && currentTime <= endTime;
  });
}

async function handleOpenPosition(tradeId, symbol, side, qty, qtyRaw, price, timestamp, precision, orderResult) {
  try {
    if (orderResult) {
      sendTelegramMessage(`✅ 开仓下单成功：${side} ${symbol} 数量: ${qty}，价格: ${price}`);
    }

    // 设置止损单（如果下单成功且启用止损）
    if (orderResult && enableStopLoss) {
      await setupStopLossOrder(symbol, side, price, timestamp, precision);
    }
    // 设置止盈单（如果下单成功且启用止盈）
    // 获取当前是否在允许的止盈时段
    const enableTakeProfitByTime = isInTradingTimeRange(config.takeProfitTimeRanges);
    const serverTime = new Date();
    const formattedTime = moment(serverTime)
      .local() // 使用服务器本地时区
      .format('YYYY年MM月DD日 HH:mm');
    sendTelegramMessage(`✅ 当前时间处于设置 ${enableTakeProfitByTime ? '止盈' : '不止盈'} 时间段: ${formattedTime}`);
    if (orderResult && enableTakeProfit && enableTakeProfitByTime) {
      await setupTakeProfitOrder(symbol, side, price, timestamp, precision);
    }

    // 记录交易（无论下单是否成功）
    const newTradeId = trade.recordTrade(db, {
      symbol: symbol,
      price: price,
      qtyRaw: qty,
      side: side
    });

    log(`✅ 开仓处理完成: ${symbol} ${side} 数量:${qty} 价格:${price} 交易ID:${newTradeId}`);
    return { tradeId: newTradeId, symbol, price, qtyRaw, side };
  } catch (err) {
    log(`❌ 开仓处理失败: ${symbol} ${side}, 原因: ${err.message}`);
    throw err;
  }
}

async function setupTakeProfitOrder(symbol, side, price, timestamp, precision) {
  try {
    const takeProfitSide = side === 'BUY' ? 'SELL' : 'BUY'; // 止盈方向与开仓方向相反
    const takeProfitPrice = side === 'BUY'
      ? (price * (1 + takeProfitRate)).toFixed(precision.pricePrecision)
      : (price * (1 - takeProfitRate)).toFixed(precision.pricePrecision);

    // 计算收益率（盈利比例）
    const profitRate = side === 'BUY'
      ? ((takeProfitPrice / price - 1) * 100 * 10).toFixed(2) + '%'  // 做多止盈：盈利比例
      : ((1 - takeProfitPrice / price) * 100 * 10).toFixed(2) + '%'; // 做空止盈：盈利比例

    const tpParams = new URLSearchParams({
      symbol,
      side: takeProfitSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: takeProfitPrice,   // 虽然叫 stopPrice，其实这里是触发价
      closePosition: 'true',
      timestamp: timestamp.toString()
    });

    const tpSignature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(tpParams.toString())
      .digest('hex');

    const tpUrl = `${BINANCE_API}/fapi/v1/order?${tpParams.toString()}&signature=${tpSignature}`;
    const tpRes = await proxyPost(tpUrl, null, { headers });

    log(`🎯 已设置止盈单 ${symbol}，触发价: ${takeProfitPrice}`);
    sendTelegramMessage(`💰 止盈挂单：${symbol} | 方向: ${takeProfitSide} | 触发价: ${takeProfitPrice} | 预计盈利: ${profitRate}`);
  } catch (error) {
    log(`⚠️ 设置止盈单失败: ${symbol}, 原因: ${err.message}`);
  }
}
async function setupStopLossOrder(symbol, side, price, timestamp, precision) {
  try {
    const stopSide = side === 'BUY' ? 'SELL' : 'BUY';
    const stopPrice = side === 'BUY'
      ? (price * (1 - stopLossRate)).toFixed(precision.pricePrecision)
      : (price * (1 + stopLossRate)).toFixed(precision.pricePrecision);

    const profitLossRate = side === 'BUY'
      ? ((stopPrice / price - 1) * 100 * 10).toFixed(2) + '%'
      : ((1 - stopPrice / price) * 100 * 10).toFixed(2) + '%';

    const stopParams = new URLSearchParams({
      symbol,
      side: stopSide,
      type: 'STOP_MARKET',
      stopPrice: stopPrice,
      closePosition: 'true',
      timestamp: timestamp.toString()
    });

    const stopSignature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(stopParams.toString())
      .digest('hex');

    const stopUrl = `${BINANCE_API}/fapi/v1/order?${stopParams.toString()}&signature=${stopSignature}`;
    const stopRes = await proxyPost(stopUrl, null, { headers: { 'X-MBX-APIKEY': config.binance.apiKey } });

    log(`🛑 已设置止损单 ${symbol}，触发价: ${stopPrice}`);
    sendTelegramMessage(`📉 止损挂单：${symbol} | 方向: ${stopSide} | 触发价: ${stopPrice} | 预计亏损: ${profitLossRate}`);
  } catch (err) {
    log(`⚠️ 设置止损单失败: ${symbol}, 原因: ${err.message}`);
    // 不抛出错误，继续执行
  }
}

module.exports = {
  placeOrder,
  placeOrderTest,
  placeOrderTestNew,
  closePositionIfNeeded,
  getAccountTrades,
  getLossIncomes,
  cleanUpOrphanedOrders
};
