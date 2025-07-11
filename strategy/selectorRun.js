// strategy/selector.js
// 策略币种选择器模块，基于 VWAP + EMA + BOLL 指标选出做多/做空信号

const { EMA, BollingerBands } = require('technicalindicators');
const { getVWAP } = require('../utils/vwap'); // VWAP计算函数
// const { getKlines } = require('../binance/market'); // 获取币种K线
const config = require('../config/config');
const { log } = require('../utils/logger');
const { isFlatMarket } = require('../utils/flatFilter');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');

// 获取指定币种的 K 线数据（默认获取 50 根）
async function fetchKlines(symbol, interval, limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

// 判断单个币种是否满足做多或做空条件
async function evaluateSymbol(symbol, interval = '3m') {
  // const klines = await getKlines(symbol, interval, 50);
  const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
  if (!klines || klines.length < 30) return null;

  const close = klines.map(k => parseFloat(k[4])); // 收盘价
  const high = klines.map(k => parseFloat(k[2]));
  const low = klines.map(k => parseFloat(k[3]));
  const volume = klines.map(k => parseFloat(k[5]));

  const lastClose = close[close.length - 1];

  // EMA金叉死叉
  const ema5 = EMA.calculate({ period: 5, values: close });
  const ema13 = EMA.calculate({ period: 13, values: close });

  // BOLL中轨判断趋势是否突破
  const boll = BollingerBands.calculate({
    period: 20,
    values: close,
    stdDev: 2,
  });

  // VWAP 计算
  const vwap = getVWAP(close, high, low, volume);
  const lastVWAP = vwap[vwap.length - 1];
  const lastEma5 = ema5[ema5.length - 1];
  const lastEma13 = ema13[ema13.length - 1];
  const lastBoll = boll[boll.length - 1]; // { upper, middle, lower }

  // ================= 多头判断条件 =================
  const isLongSignal =
    lastClose > lastVWAP &&                     // 价格在 VWAP 上方
    lastEma5 > lastEma13 &&                     // EMA 金叉
    close[close.length - 2] < lastBoll.middle && // 上一根K线在中轨下方
    lastClose > lastBoll.middle;               // 当前K线刚突破中轨

  // ================= 空头判断条件 =================
  const isShortSignal =
    lastClose < lastVWAP &&                     // 价格在 VWAP 下方
    lastEma5 < lastEma13 &&                     // EMA 死叉
    close[close.length - 2] > lastBoll.middle && // 上一根K线在中轨上方
    lastClose < lastBoll.middle;               // 当前K线跌破中轨

  if (isLongSignal) {
    log(`🟢 ${symbol} 符合做多信号`);
    return { symbol, side: 'LONG' };
  }

  if (isShortSignal) {
    log(`🔴 ${symbol} 符合做空信号`);
    return { symbol, side: 'SHORT' };
  }

  return null; // 无信号
}

// 遍历 Top50 币种，返回最先满足条件的币种（可扩展排序机制）
async function selectSymbolFromList(symbolList) {
  const results = [];

  for (const symbol of symbolList) {
    try {
      const res = await evaluateSymbol(symbol);
      if (res) results.push(res);
    } catch (err) {
      log(`❌ ${symbol} 判断失败: ${err.message}`);
    }
  }

  // 暂定返回第一个满足条件的币种，未来可按优先级排序
  return results.length > 0 ? results[0] : null;
}

// 评估一个币种的做多或做空信号，并给出强度评分
async function evaluateSymbolWithScore(symbol, interval = '3m') {
  // const klines = await getKlines(symbol, interval, 100); // 拉取足够的历史K线
  const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
  if (!klines || klines.length < 50) return null;

  const close = klines.map(k => parseFloat(k[4])).filter(x => !isNaN(x));
  const high = klines.map(k => parseFloat(k[2])).filter(x => !isNaN(x));
  const low = klines.map(k => parseFloat(k[3])).filter(x => !isNaN(x));
  const volume = klines.map(k => parseFloat(k[5])).filter(x => !isNaN(x));


  // ========== 横盘震荡过滤 ==========
  const flat = isFlatMarket({ close, high, low }, 0.005, 0.01); // 参数可调
  if (flat) {
    log(`🚫 ${symbol} 横盘震荡过滤`);
    return null;
  }

  // ========== 计算指标 ==========
  const ema5 = EMA.calculate({ period: 5, values: close });
  const ema13 = EMA.calculate({ period: 13, values: close });
  const boll = BollingerBands.calculate({ period: 20, values: close });
  const vwap = getVWAP(close, high, low, volume);

  log(`${symbol} → ema5=${ema5.length}, ema13=${ema13.length}, boll=${boll.length}, vwap=${vwap.length}`);


  // 对齐所有指标长度
  const minLength = Math.min(ema5.length, ema13.length, boll.length, vwap.length);

  if (ema5.length < 1 || ema13.length < 1 || boll.length < 2 || vwap.length < 1) {
    log(`❌ ${symbol} 指标长度不足: ema5=${ema5.length}, ema13=${ema13.length}, boll=${boll.length}, vwap=${vwap.length}`);
    return null;
  }


  const offset = close.length - minLength;
  const alignedClose = close.slice(offset);
  const alignedEma5 = ema5.slice(-minLength);
  const alignedEma13 = ema13.slice(-minLength);
  const alignedVWAP = vwap.slice(-minLength);
  const alignedBoll = boll.slice(-minLength);

  // 使用最后一根作为判断依据
  const lastClose = alignedClose[minLength - 1];
  const prevClose = alignedClose[minLength - 2];

  const lastEma5 = alignedEma5[minLength - 1];
  const lastEma13 = alignedEma13[minLength - 1];

  const lastVWAP = alignedVWAP[minLength - 1];

  const lastBoll = alignedBoll[minLength - 1];
  const prevBoll = alignedBoll[minLength - 2];

  // ========== 打分逻辑 ==========
  let longScore = 0;
  let shortScore = 0;

  if (lastClose > lastVWAP) longScore++;
  if (lastEma5 > lastEma13) longScore++;
  if (lastClose > lastBoll.middle) longScore++;
  if (lastClose > lastBoll.upper) longScore++;
  if (lastEma5 - lastEma13 > 0.05) longScore++;

  if (lastClose < lastVWAP) shortScore++;
  if (lastEma5 < lastEma13) shortScore++;
  if (lastClose < lastBoll.middle) shortScore++;
  if (lastClose < lastBoll.lower) shortScore++;
  if (lastEma13 - lastEma5 > 0.05) shortScore++;

  // ========== 最终信号选择 ==========
  const threshold = 3;
  let signal = null;
  let score = 0;

  if (longScore >= threshold && longScore >= shortScore) {
    signal = 'LONG';
    score = longScore;
  } else if (shortScore >= threshold) {
    signal = 'SHORT';
    score = shortScore;
  }

  log(`✅ ${symbol}: side=${signal}, longScore=${longScore}, shortScore=${shortScore}`);
  log(`${symbol} → close=${lastClose.toFixed(4)}, ema5=${lastEma5.toFixed(4)}, ema13=${lastEma13.toFixed(4)}, vwap=${lastVWAP.toFixed(4)}`);

  if (!signal) return null;
  return { symbol, side: signal, score };
}

// 遍历多个币种，返回 topN 的多头和空头
async function getTopLongShortSymbols(symbolList, topN = 3) {
  const longList = [];
  const shortList = [];

  for (const symbol of symbolList) {
    try {
      log(`✅ ${symbol} 开始校验:`);
      const res = await evaluateSymbolWithScore(symbol);
      if (!res) continue;
      if (res?.side === 'LONG') longList.push(res);
      if (res?.side === 'SHORT') shortList.push(res);
    } catch (err) {
      log(`❌ ${symbol} 评估失败: ${err.message}`);
    }
  }

  const topLong = longList.sort((a, b) => b.score - a.score).slice(0, topN);
  const topShort = shortList.sort((a, b) => b.score - a.score).slice(0, topN);
  log(`Top Longs: ${JSON.stringify(topLong, null, 2)}`);
  log(`Top Shorts: ${JSON.stringify(topShort, null, 2)}`);
  return { topLong, topShort };
}



module.exports = { getTopLongShortSymbols };
