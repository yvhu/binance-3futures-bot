// strategy/selector.js
// 策略币种选择器模块，基于 VWAP + EMA + BOLL 指标选出做多/做空信号

const { EMA, BollingerBands } = require('technicalindicators');
const { getVWAP } = require('../utils/vwap'); // VWAP计算函数
// const { getKlines } = require('../binance/market'); // 获取币种K线
const config = require('../config/config');
const { log } = require('../utils/logger');
const { isFlatMarket, dynamicPriceRangeRatio, calculateADX } = require('../utils/flatFilter');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const { getCurrentPrice } = require('../binance/market');
const moment = require('moment-timezone');
const { isInTradingTimeRange } = require('../utils/utils');

// 获取指定币种的 K 线数据（默认获取 50 根）
async function fetchKlines(symbol, interval, limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    openTime: k[0],                    // 开盘时间
    open: parseFloat(k[1]),            // 开盘价
    high: parseFloat(k[2]),            // 最高价
    low: parseFloat(k[3]),             // 最低价
    close: parseFloat(k[4]),           // 收盘价
    volume: parseFloat(k[5]),          // 成交量
    closeTime: k[6],                   // 收盘时间
    quoteVolume: parseFloat(k[7]),     // 成交额
    trades: k[8],                      // 成交笔数
    takerBuyBaseVolume: parseFloat(k[9]),  // 主动买入成交量
    takerBuyQuoteVolume: parseFloat(k[10]), // 主动买入成交额
    ignore: parseFloat(k[11])          // 忽略字段
  }));
}

async function evaluateSymbolWithScore(symbol, interval = '15m') {
  const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
  const lastKline = klines[klines.length - 1];

  // ============ 计算震荡幅度 ==========
  const recent10Klines = klines.slice(-10);
  const oscillations = recent10Klines.map(kline => {
    return (kline.high - kline.low) / kline.open * 100;
  });
  const avgOscillation = oscillations.reduce((a, b) => a + b, 0) / oscillations.length;
  const isConditionMet = avgOscillation > 0.6;
  if (!isConditionMet) {
    return null;
  }
  if (!klines || klines.length < 50) return null;

  // 提取价格和成交量数据
  const close = klines.map(k => Number(k.close)).filter(v => !isNaN(v));
  const high = klines.map(k => Number(k.high)).filter(v => !isNaN(v));
  const low = klines.map(k => Number(k.low)).filter(v => !isNaN(v));
  const volume = klines.map(k => Number(k.volume)).filter(v => !isNaN(v));

  // ========== 计算平均成交量 ==========
  const volumePeriod = 50;
  const avgVolume = volume.slice(-volumePeriod).reduce((a, b) => a + b, 0) / volumePeriod;

  // 计算成交量EMA和标准差
  const volumeEMA = EMA.calculate({ period: 20, values: volume });
  const lastVolumeEMA = volumeEMA[volumeEMA.length - 1];

  const volumeStdDev = Math.sqrt(
    volume.slice(-volumePeriod).reduce((sum, vol) => sum + Math.pow(vol - avgVolume, 2), 0) / volumePeriod
  );

  // ========== 修复：统一使用相同的EMA和布林带参数 ==========
  const ema5 = EMA.calculate({ period: 5, values: close });
  const ema13 = EMA.calculate({ period: 13, values: close });
  const boll = BollingerBands.calculate({ period: 20, values: close, stdDev: 2 });

  const vwap = getVWAP(close, high, low, volume);
  const atr = calculateATR(klines, 14);

  // 对齐所有指标长度
  const minLength = Math.min(ema5.length, ema13.length, boll.length, vwap.length, atr.length, volumeEMA.length);
  if (minLength < 2) {
    return null;
  }

  const offset = close.length - minLength;
  const alignedClose = close.slice(offset);
  const alignedEma5 = ema5.slice(-minLength);
  const alignedEma13 = ema13.slice(-minLength);
  const alignedVWAP = vwap.slice(-minLength);
  const alignedBoll = boll.slice(-minLength);
  const alignedATR = atr.slice(-minLength);
  const alignedVolume = volume.slice(offset);
  const alignedVolumeEMA = volumeEMA.slice(-minLength);

  // 获取最新值
  const lastClose = alignedClose[minLength - 1];
  const lastEma5 = alignedEma5[minLength - 1];
  const lastEma13 = alignedEma13[minLength - 1];
  const lastVWAP = alignedVWAP[minLength - 1];
  const lastBoll = alignedBoll[minLength - 1];
  const lastATR = alignedATR[minLength - 1];
  const lastVolume = alignedVolume[minLength - 1];
  const lastVolumeEMAValue = alignedVolumeEMA[minLength - 1];
  const atrPercent = lastATR / lastClose;

  const currentPrice = await getCurrentPrice(symbol);
  const baseRatio = dynamicPriceRangeRatio(currentPrice, atr, config.baseRatio);

  // ========== 趋势确认函数 ==========
  const trendConfirmation = (values, period) => {
    const changes = [];
    for (let i = 1; i <= period; i++) {
      changes.push(values[values.length - i] > values[values.length - i - 1]);
    }
    return changes.filter(x => x).length >= Math.floor(period * 0.6);
  };

  // ========== 成交量判断 ==========
  const volumeRatio = lastVolume / avgVolume;
  const volumeEMARatio = lastVolume / lastVolumeEMAValue;
  
  const isVolumeSpike = (volumeRatio > 1.4 || volumeEMARatio > 1.4) || lastVolume > avgVolume + 1.2 * volumeStdDev;
  const isVolumeDecline = (volumeRatio < 0.9 || volumeEMARatio < 0.9) || lastVolume < avgVolume - 1.0 * volumeStdDev;

  // 成交量趋势判断
  const volumeTrendUp = trendConfirmation(alignedVolume, 3);
  const volumeTrendDown = trendConfirmation(alignedVolume.map(x => -x), 3);

  // ========== 横盘震荡过滤 ==========
  const flat = isFlatMarket({ close, high, low }, 0.005, baseRatio);
  if (flat) {
    return null;
  }

  const uptrendConfirmed = trendConfirmation(alignedClose, 5);
  const downtrendConfirmed = trendConfirmation(alignedClose.map(x => -x), 5);

  // ========== 波动性和成交量过滤 ==========
  if (atrPercent < 0.003) return null;

  const enableTakeProfitByTime = isInTradingTimeRange(config.takeSelectRunTimeRanges);
  if (!enableTakeProfitByTime) {
    return null;
  }

  // ========== 修复：重新设计打分逻辑 ==========
  let longScore = 0;
  let shortScore = 0;

  // 基础条件（修复可能的逻辑错误）
  if (lastClose > lastVWAP) longScore += 1;
  if (lastEma5 > lastEma13) longScore += 1;
  if (lastClose > lastBoll.middle) longScore += 1;

  if (lastClose < lastVWAP) shortScore += 1;
  if (lastEma5 < lastEma13) shortScore += 1;
  if (lastClose < lastBoll.middle) shortScore += 1;

  // 强势条件（确保方向正确）
  if (lastClose > lastBoll.upper && isVolumeSpike && volumeTrendUp && uptrendConfirmed) longScore += 2;
  if (lastClose < lastBoll.lower && isVolumeSpike && volumeTrendDown && downtrendConfirmed) shortScore += 2;

  // EMA金叉死叉确认（修复：确保是最近发生的）
  const prevEma5 = alignedEma5[minLength - 2];
  const prevEma13 = alignedEma13[minLength - 2];
  
  if (lastEma5 > lastEma13 && prevEma5 <= prevEma13) longScore += 2; // 金叉
  if (lastEma5 < lastEma13 && prevEma5 >= prevEma13) shortScore += 2; // 死叉

  // ========== 最终信号选择 ==========
  const threshold = 4; // 提高阈值
  let signal = null;
  let score = 0;

  // 修复：确保信号有足够的优势
  if (longScore >= threshold && longScore > shortScore + 1) {
    signal = 'LONG';
    score = longScore;
  } else if (shortScore >= threshold && shortScore > longScore + 1) {
    signal = 'SHORT';
    score = shortScore;
  }

  if (!signal) return null;

  return {
    symbol,
    side: signal,
    score,
    price: lastClose,
    indicators: {
      ema5: lastEma5,
      ema13: lastEma13,
      vwap: lastVWAP,
      bollinger: lastBoll,
      atr: lastATR,
      volume: lastVolume,
      avgVolume,
      volumeEMA: lastVolumeEMAValue,
      volumeStdDev,
      volumeTrend: volumeTrendUp ? 'up' : volumeTrendDown ? 'down' : 'neutral'
    }
  };
}

// 修改测试函数，添加调试
async function getTopLongShortSymbolsTest(symbolList, topN = 3, interval) {
  const longList = [];
  const shortList = [];

  for (const symbol of symbolList) {
    try {
      const res = await evaluateSymbolWithScore(symbol, interval);
      if (!res) continue;
      
      // 添加调试信息
      console.log(`${symbol} - ${res.side} - 得分: ${res.score} - 价格: ${res.price}`);
      console.log(`  EMA5: ${res.indicators.ema5}, EMA13: ${res.indicators.ema13}`);
      console.log(`  VWAP: ${res.indicators.vwap}, 布林中轨: ${res.indicators.bollinger.middle}`);
      
      if (res.side === 'LONG') longList.push(res);
      if (res.side === 'SHORT') shortList.push(res);

    } catch (err) {
      console.log(`❌ ${symbol} 评估失败: ${err.message}`);
    }
  }
  
  const topLong = longList.sort((a, b) => b.score - a.score).slice(0, topN);
  const topShort = shortList.sort((a, b) => b.score - a.score).slice(0, topN);
  
  return { topLong, topShort };
}

// ========== 辅助函数 ==========
function calculateATR(klines, period = 14) {
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const closes = klines.map(k => k.close);

  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  const atr = new Array(period).fill(NaN);
  let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
  atr.push(sum / period);

  for (let i = period + 1; i < closes.length; i++) {
    atr.push((atr[i - 1] * (period - 1) + tr[i - 1]) / period);
  }

  return atr;
}

// 遍历多个币种，返回 topN 的多头和空头
async function getTopLongShortSymbols(symbolList, topN = 3) {
  const longList = [];
  const shortList = [];

  for (const symbol of symbolList) {
    try {
      // log(`✅ ${symbol} 开始校验:`);
      const res = await evaluateSymbolWithScore(symbol, config.interval);
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

module.exports = { getTopLongShortSymbols, getTopLongShortSymbolsTest, fetchKlines };
