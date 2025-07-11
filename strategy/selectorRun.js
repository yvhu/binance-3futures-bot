// strategy/selector.js
// 策略币种选择器模块，基于 VWAP + EMA + BOLL 指标选出做多/做空信号

const { EMA, BollingerBands } = require('technicalindicators');
const { getVWAP } = require('../utils/vwap'); // VWAP计算函数
const { getKlines } = require('../binance/market'); // 获取币种K线
const config = require('../config/config');
const { log } = require('../utils/logger');

// 判断单个币种是否满足做多或做空条件
async function evaluateSymbol(symbol, interval = '3m') {
  const klines = await getKlines(symbol, interval, 50);
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
  const klines = await getKlines(symbol, interval, 50);
  if (!klines || klines.length < 30) return null;

  const close = klines.map(k => parseFloat(k[4]));
  const high = klines.map(k => parseFloat(k[2]));
  const low = klines.map(k => parseFloat(k[3]));
  const volume = klines.map(k => parseFloat(k[5]));

  const lastClose = close[close.length - 1];
  const ema5 = EMA.calculate({ period: 5, values: close });
  const ema13 = EMA.calculate({ period: 13, values: close });
  const boll = BollingerBands.calculate({ period: 20, values: close, stdDev: 2 });
  const vwap = getVWAP(close, high, low, volume);

  const lastVWAP = vwap[vwap.length - 1];
  const lastEma5 = ema5[ema5.length - 1];
  const lastEma13 = ema13[ema13.length - 1];
  const lastBoll = boll[boll.length - 1];

  const prevClose = close[close.length - 2];
  const prevBollMiddle = boll[boll.length - 2]?.middle;

  let signal = null;
  let score = 0;

  // ============ 多头打分 ============
  if (
    lastClose > lastVWAP &&
    lastEma5 > lastEma13 &&
    prevClose < prevBollMiddle &&
    lastClose > lastBoll.middle
  ) {
    signal = 'LONG';
    score += 1;
    if (lastClose > lastEma5) score += 1;
    if (lastClose > lastBoll.upper) score += 1; // 强势突破上轨
    if (lastEma5 - lastEma13 > 0.1) score += 1;  // EMA角度大
  }

  // ============ 空头打分 ============
  if (
    lastClose < lastVWAP &&
    lastEma5 < lastEma13 &&
    prevClose > prevBollMiddle &&
    lastClose < lastBoll.middle
  ) {
    signal = 'SHORT';
    score += 1;
    if (lastClose < lastEma5) score += 1;
    if (lastClose < lastBoll.lower) score += 1;
    if (lastEma13 - lastEma5 > 0.1) score += 1;
  }

  if (!signal || score === 0) return null;

  return { symbol, side: signal, score };
}

// 遍历多个币种，返回 topN 的多头和空头
async function getTopLongShortSymbols(symbolList, topN = 3) {
  const longList = [];
  const shortList = [];

  for (const symbol of symbolList) {
    try {
      const res = await evaluateSymbolWithScore(symbol);
      if (!res) continue;
      if (res.side === 'LONG') longList.push(res);
      if (res.side === 'SHORT') shortList.push(res);
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
