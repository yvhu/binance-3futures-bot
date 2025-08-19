const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const config = require('../config/config');
const { sendTelegramMessage } = require('../telegram/messenger');
const { log } = require('../utils/logger');
const crypto = require('crypto');
const { getSymbolPrecision } = require('../utils/cache');
const { getCurrentPrice } = require('./market');
const { getCachedPositionRatio } = require('../utils/cache');
const _ = require('lodash');
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
  const mode = 'amount';
  const leverage = config.leverage || 10;

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
  const params = new URLSearchParams({
    symbol,
    leverage: leverage.toString(),
    timestamp: String(Date.now()),
  });
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret.trim()) // 同样trim()处理
    .update(params.toString())
    .digest('hex');
  const url = `${BINANCE_API}/fapi/v1/leverage?${params.toString()}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey.trim() };
  try {
    const res = await proxyPost(url, null, { headers });
    log(`✅ 设置杠杆成功 ${symbol}：${leverage}x`);
    return res.data;
  } catch (error) {
    log(`❌ 设置杠杆失败 ${symbol}:`, error.response?.data || error.message);
    throw error;
  }
}

// ========== 基础API封装 ==========
async function fetchAllPositions() {
  // 1. 创建查询参数（包含当前时间戳，防止请求重放）
  const params = new URLSearchParams({ timestamp: Date.now() });

  // 2. 对参数进行签名（需使用API密钥的SECRET）
  const signature = signParams(params);

  // 3. 构造完整的请求URL（包含签名）
  const url = `${config.binance.baseUrl}/fapi/v2/positionRisk?${params}&signature=${signature}`;

  // 4. 发送GET请求（通过代理工具proxyGet）
  const res = await proxyGet(url, { headers: { 'X-MBX-APIKEY': config.binance.apiKey } });

  // 5. 过滤持仓数量为0的合约，仅返回有效持仓
  return res.data.filter(p => Math.abs(Number(p.positionAmt)) > 0);
}

// 获取委托信息
async function fetchOpenOrders() {
  const params = new URLSearchParams({ timestamp: Date.now() });
  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v1/openOrders?${params}&signature=${signature}`;
  const response = await proxyGet(url, { headers: { 'X-MBX-APIKEY': config.binance.apiKey } });
  // log('当前委托:', JSON.stringify(response.data, null, 2));
  return response.data;
}

async function cancelOrder(symbol, orderId) {
  log(`✅ 撤销${symbol} 单号：${orderId} 止盈止损订单`);
  const params = new URLSearchParams({
    symbol,
    orderId,
    timestamp: String(Date.now()),
  });
  const signature = signParams(params);
  const url = `${config.binance.baseUrl}/fapi/v1/order?${params.toString()}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };
  return proxyDelete(url, { headers });
}

function signParams(params) {
  return crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(params.toString())
    .digest('hex');
}



// -----------新完整结构------------


async function placeOrderTestNew(symbol, side = 'BUY', positionAmt, isPosition) {
  try {
    const price = await getCurrentPrice(symbol);
    await setLeverage(symbol, config.leverage);
    const qtyRaw = positionAmt ? parseFloat(positionAmt) : await calcOrderQty(symbol, price);

    if (!positionAmt && (!qtyRaw || Math.abs(qtyRaw) <= 0)) {
      // log(`⚠️ ${symbol} 无法下单：数量为 0，跳过。可能因为余额不足或数量低于最小值。`);
      sendTelegramMessage(`⚠️ 跳过 ${symbol} 下单：数量为 ${qtyRaw}，可能因为余额不足或不满足最小下单量`);
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
      timestamp: String(Date.now())
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
      if ((!positionAmt) || (positionAmt && isPosition)) {
        // log(positionAmt ? `📥 平仓下单开始` : `📥 开仓下单开始`);
        // log(`finalUrl: ${finalUrl} `);
        orderResult = await proxyPost(finalUrl, null, { headers });
        // log(`📥 下单请求已发送 ${side} ${symbol}, 数量: ${qty}`);
        if (!orderResult?.data?.orderId) {
          throw new Error("未获取到 orderId，返回数据异常");
        }
        // 撤单止盈止损订单只有在平仓的时候
        // log(`📥 下单请求返回的参数ID:${orderResult.data.orderId}`);
        if ((positionAmt && isPosition && orderResult.data.orderId)) {
          await cancelOrder(symbol, orderResult.data.orderId);
        }
      }
    } catch (error) {
      // 4. 增强错误处理（优化后）
      let errorMsg = error.message;

      // 特定错误处理
      if (error.response) {
        errorMsg += ` | 状态码: ${error.response.status}`;

        // 处理订单已完成的情况
        if (error.response.data?.code === -2011 ||
          error.response.data?.msg?.includes('UNKNOWN_ORDER')) {
          errorMsg = `订单已自动完成: ${errorMsg}`;
          log(`ℹ️ ${symbol} ${errorMsg}`);
          return; // 非致命错误，直接返回
        }

        if (error.response.data?.code === -2019) {
          errorMsg = `您的账户保证金不足: ${errorMsg}`;
          log(`ℹ️ ${symbol} ${errorMsg}`);
          return; // 非致命错误，直接返回
        }

        if (error.response.data) {
          errorMsg += ` | 返回: ${JSON.stringify(error.response.data)}`;
        }
      }

      log(`❌ ${symbol} 下单失败详情: ${errorMsg}`);
      // sendTelegramMessage(`⚠️ ${symbol} 下单失败: ${errorMsg}`);
    }
  } catch (error) {
    log(`❌ 下单流程出现异常: ${symbol} ${side}, 原因: ${error.message}`);
    throw error;
  }
}

// 拆分出的API调用函数
async function createTakeProfitOrder(symbol, side, stopPrice) {
  const tpParams = new URLSearchParams({
    symbol,
    side,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice,  // 虽然参数名为stopPrice，实际是触发价
    closePosition: 'true',
    timestamp: String(Date.now()),
  });

  const tpSignature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(tpParams.toString())
    .digest('hex');

  const tpUrl = `${BINANCE_API}/fapi/v1/order?${tpParams.toString()}&signature=${tpSignature}`;
  const tpRes = await proxyPost(tpUrl, null, { headers: { 'X-MBX-APIKEY': config.binance.apiKey } });

  return tpRes;
}

// 拆分出的API调用函数
async function createStopLossOrder(symbol, side, stopPrice) {
  const stopParams = new URLSearchParams({
    symbol,
    side,
    type: 'STOP_MARKET',
    stopPrice,
    closePosition: 'true',
    timestamp: String(Date.now()),
  });

  const stopSignature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(stopParams.toString())
    .digest('hex');

  const stopUrl = `${BINANCE_API}/fapi/v1/order?${stopParams.toString()}&signature=${stopSignature}`;
  const stopRes = await proxyPost(stopUrl, null, { headers: { 'X-MBX-APIKEY': config.binance.apiKey } });

  return stopRes;
}

module.exports = {
  placeOrderTestNew,
  fetchAllPositions,
  fetchOpenOrders,
  cancelOrder,
  createTakeProfitOrder,
  createStopLossOrder,
};
