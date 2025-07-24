// strategy/selector.js
// 策略币种选择器模块，基于 VWAP + EMA + BOLL 指标选出做多/做空信号

const { EMA, BollingerBands } = require('technicalindicators');
const { getVWAP } = require('../utils/vwap'); // VWAP计算函数
// const { getKlines } = require('../binance/market'); // 获取币种K线
const config = require('../config/config');
const { log } = require('../utils/logger');
const { isFlatMarket, dynamicPriceRangeRatio } = require('../utils/flatFilter');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const { getCurrentPrice } = require('../binance/market');


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

// 评估一个币种的做多或做空信号，并给出强度评分
async function evaluateSymbolWithScore(symbol, interval = '3m') {
  // const klines = await fetchKlines(symbol, interval, 100); // 拉取足够的历史K线
  const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
  const lastKline = klines[klines.length - 1]; // 获取最后一根K线

  // 打印最后一根K线的所有参数
  // log(`📊 最后一根K线数据 (${symbol} ${interval}):`);
  // log(`  开盘时间: ${new Date(lastKline.openTime).toISOString()}`);
  // log(`  开盘价: ${lastKline.open}`);
  // log(`  最高价: ${lastKline.high}`);
  // log(`  最低价: ${lastKline.low}`);
  // log(`  收盘价: ${lastKline.close}`);
  // log(`  成交量: ${lastKline.volume}`);
  // log(`  收盘时间: ${new Date(lastKline.closeTime).toISOString()}`);
  // log(`  成交额: ${lastKline.quoteVolume}`);
  // log(`  成交笔数: ${lastKline.trades}`);
  // log(`  主动买入成交量: ${lastKline.takerBuyBaseVolume}`);
  // log(`  主动买入成交额: ${lastKline.takerBuyQuoteVolume}`);

  if (!klines || klines.length < 50) return null;

  // 提取价格和成交量数据
  const close = klines.map(k => Number(k.close)).filter(v => !isNaN(v));
  const high = klines.map(k => Number(k.high)).filter(v => !isNaN(v));
  const low = klines.map(k => Number(k.low)).filter(v => !isNaN(v));
  const volume = klines.map(k => Number(k.volume)).filter(v => !isNaN(v));

  // ========== 计算平均成交量 ==========
  const volumePeriod = 50; // 使用更长周期计算平均成交量
  const avgVolume = volume.slice(-volumePeriod).reduce((a, b) => a + b, 0) / volumePeriod;

  // 计算成交量EMA和标准差
  const volumeEMA = EMA.calculate({ period: 20, values: volume });
  const lastVolumeEMA = volumeEMA[volumeEMA.length - 1];

  const volumeStdDev = Math.sqrt(
    volume.slice(-volumePeriod).reduce((sum, vol) => sum + Math.pow(vol - avgVolume, 2), 0) / volumePeriod
  );

  // ========== 计算指标 ==========
  const ema5 = EMA.calculate({ period: 5, values: close });
  const ema13 = EMA.calculate({ period: 13, values: close });
  const boll = BollingerBands.calculate({ period: 20, values: close, stdDev: 2 });
  const vwap = getVWAP(close, high, low, volume);
  const atr = calculateATR(klines, 14);

  // 对齐所有指标长度
  const minLength = Math.min(ema5.length, ema13.length, boll.length, vwap.length, atr.length, volumeEMA.length);
  if (minLength < 2) {
    log(`❌ ${symbol} 指标长度不足`);
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

  // 获取最新值 minLength - 1（index=长度-1取最后一个数据）
  const lastClose = alignedClose[minLength - 1];
  const prevClose = alignedClose[minLength - 1];
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
    // 改为60%或使用加权确认
    return changes.filter(x => x).length >= Math.floor(period * 0.6);
  };

  // ========== 改进的成交量判断 ==========
  const volumeRatio = lastVolume / avgVolume;
  const volumeEMARatio = lastVolume / lastVolumeEMAValue;
  // 改为或条件而非与条件
  const isVolumeSpike = (volumeRatio > 1.5 || volumeEMARatio > 1.5) ||
    lastVolume > avgVolume + 1.5 * volumeStdDev;
  const isVolumeDecline = (volumeRatio < 0.85 || volumeEMARatio < 0.85) ||
    lastVolume < avgVolume - 1.5 * volumeStdDev;

  // 成交量趋势判断
  const volumeTrendUp = trendConfirmation(alignedVolume, 3);
  const volumeTrendDown = trendConfirmation(alignedVolume.map(x => -x), 3);

  // ========== 横盘震荡过滤 ==========
  const flat = isFlatMarket({ close, high, low }, 0.005, baseRatio);
  if (flat) {
    log(`🚫 ${symbol} 横盘震荡过滤`);
    return null;
  }

  const uptrendConfirmed = trendConfirmation(alignedClose, 5);
  const downtrendConfirmed = trendConfirmation(alignedClose.map(x => -x), 5);

  // ========== 波动性和成交量过滤 ==========
  if (atrPercent < 0.002) {
    log(`🚫 ${symbol} 波动性太小(ATR=${atrPercent.toFixed(4)})`);
    return null;
  }

  if (isVolumeDecline) {
    log(`🚫 ${symbol} 成交量不足(当前=${lastVolume}, 平均=${avgVolume.toFixed(2)}, EMA=${lastVolumeEMAValue.toFixed(2)}, 标准差=${volumeStdDev.toFixed(2)})`);
    return null;
  }

  // ========== 时间过滤 ==========
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  if ((hours >= 1 && hours < 5) || (hours === 12 && minutes >= 30)) {
    log(`🚫 ${symbol} 当前时段流动性不足`);
    return null;
  }

  // ========== 改进后的打分逻辑 ==========
  let longScore = 0;
  let shortScore = 0;

  // 基础条件
  if (lastClose > lastVWAP) longScore += 0.5;
  if (lastEma5 > lastEma13) longScore += 0.5;
  if (lastClose > lastBoll.middle) longScore += 0.5;

  if (lastClose < lastVWAP) shortScore += 0.5;
  if (lastEma5 < lastEma13) shortScore += 0.5;
  if (lastClose < lastBoll.middle) shortScore += 0.5;

  // 根据ATR百分比动态调整阈值
  // const atrBasedThreshold = lastATR / lastClose * 1.5;  // 例如：2倍ATR百分比
  // 结合波动率和时间周期
  const baseFactor = 1.5; // 基础倍数
  const volatilityAdjustment = (lastATR / lastClose) * 100; // ATR占比百分比
  const dynamicFactor = baseFactor + volatilityAdjustment / 50; // 每1%波动率增加0.02倍

  const atrBasedThreshold = lastATR * Math.min(dynamicFactor, 2.5); // 不超过2.5倍
  // 强势条件(权重更高)
  if (lastClose > lastBoll.upper && isVolumeSpike && volumeTrendUp) longScore += 2;
  if (lastClose < lastBoll.lower && isVolumeSpike && volumeTrendDown) shortScore += 2;
  if (lastEma5 - lastEma13 > atrBasedThreshold && uptrendConfirmed && volumeTrendUp) longScore += 1;
  if (lastEma13 - lastEma5 > atrBasedThreshold && downtrendConfirmed && volumeTrendDown) shortScore += 1;

  log(`✅ ${symbol}: (lastClose: ${lastClose} lastVWAP: ${lastVWAP} lastBoll.middle: ${lastBoll.middle} lastBoll.lower: ${lastBoll.lower} volumeTrendDown:${volumeTrendDown})`);
  log(`✅ ${symbol}: (lastClose: ${lastClose} lastBoll.upper: ${lastBoll.upper} isVolumeSpike: ${isVolumeSpike} volumeTrendUp: ${volumeTrendUp})`);
  log(`✅ ${symbol}: (lastEma5: ${lastEma5} lastEma13: ${lastEma13} atrBasedThreshold: ${atrBasedThreshold} downtrendConfirmed: ${downtrendConfirmed} uptrendConfirmed: ${uptrendConfirmed} )`);

  // ========== 最终信号选择 ==========
  const threshold = 3;
  let signal = null;
  let score = 0;
  log(`✅ ${symbol}: (得分: longScore-${longScore} shortScore-${shortScore})`);
  if (longScore >= threshold && longScore >= shortScore) {
    signal = 'LONG';
    score = longScore;
  } else if (shortScore >= threshold) {
    signal = 'SHORT';
    score = shortScore;
  }

  if (!signal) return null;

  // 记录详细信息
  log(`✅ ${symbol}: ${signal} (得分: ${score})`);
  log(`  收盘价: ${lastClose.toFixed(4)} | EMA5: ${lastEma5.toFixed(4)} | EMA13: ${lastEma13.toFixed(4)}`);
  log(`  VWAP: ${lastVWAP.toFixed(4)} | 布林带: ${lastBoll.middle.toFixed(4)} [${lastBoll.lower.toFixed(4)}, ${lastBoll.upper.toFixed(4)}]`);
  log(`  成交量: ${lastVolume.toFixed(2)} (平均=${avgVolume.toFixed(2)}, EMA=${lastVolumeEMAValue.toFixed(2)}, 标准差=${volumeStdDev.toFixed(2)})`);
  log(`  ATR: ${lastATR.toFixed(4)} (${(atrPercent * 100).toFixed(2)}%) | 成交量趋势: ${volumeTrendUp ? '↑' : volumeTrendDown ? '↓' : '→'}`);

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



module.exports = { getTopLongShortSymbols };
