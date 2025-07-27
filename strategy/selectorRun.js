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
// async function evaluateSymbolWithScore(symbol, interval = '3m') {
//   // const klines = await fetchKlines(symbol, interval, 100); // 拉取足够的历史K线
//   const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
//   const lastKline = klines[klines.length - 1]; // 获取最后一根K线

//   // 打印最后一根K线的所有参数
//   // log(`📊 最后一根K线数据 (${symbol} ${interval}):`);
//   // log(`  开盘时间: ${new Date(lastKline.openTime).toISOString()}`);
//   // log(`  开盘价: ${lastKline.open}`);
//   // log(`  最高价: ${lastKline.high}`);
//   // log(`  最低价: ${lastKline.low}`);
//   // log(`  收盘价: ${lastKline.close}`);
//   // log(`  成交量: ${lastKline.volume}`);
//   // log(`  收盘时间: ${new Date(lastKline.closeTime).toISOString()}`);
//   // log(`  成交额: ${lastKline.quoteVolume}`);
//   // log(`  成交笔数: ${lastKline.trades}`);
//   // log(`  主动买入成交量: ${lastKline.takerBuyBaseVolume}`);
//   // log(`  主动买入成交额: ${lastKline.takerBuyQuoteVolume}`);

//   if (!klines || klines.length < 50) return null;

//   // 提取价格和成交量数据
//   const close = klines.map(k => Number(k.close)).filter(v => !isNaN(v));
//   const high = klines.map(k => Number(k.high)).filter(v => !isNaN(v));
//   const low = klines.map(k => Number(k.low)).filter(v => !isNaN(v));
//   const volume = klines.map(k => Number(k.volume)).filter(v => !isNaN(v));

//   // ========== 计算平均成交量 ==========
//   const volumePeriod = 50; // 使用更长周期计算平均成交量
//   const avgVolume = volume.slice(-volumePeriod).reduce((a, b) => a + b, 0) / volumePeriod;

//   // 计算成交量EMA和标准差
//   const volumeEMA = EMA.calculate({ period: 20, values: volume });
//   const lastVolumeEMA = volumeEMA[volumeEMA.length - 1];

//   const volumeStdDev = Math.sqrt(
//     volume.slice(-volumePeriod).reduce((sum, vol) => sum + Math.pow(vol - avgVolume, 2), 0) / volumePeriod
//   );

//   // ========== 计算指标 ==========
//   const ema5 = EMA.calculate({ period: 5, values: close });
//   const ema13 = EMA.calculate({ period: 13, values: close });
//   const boll = BollingerBands.calculate({ period: 20, values: close, stdDev: 2 });
//   const vwap = getVWAP(close, high, low, volume);
//   const atr = calculateATR(klines, 14);

//   // 对齐所有指标长度
//   const minLength = Math.min(ema5.length, ema13.length, boll.length, vwap.length, atr.length, volumeEMA.length);
//   if (minLength < 2) {
//     log(`❌ ${symbol} 指标长度不足`);
//     return null;
//   }

//   const offset = close.length - minLength;
//   const alignedClose = close.slice(offset);
//   const alignedEma5 = ema5.slice(-minLength);
//   const alignedEma13 = ema13.slice(-minLength);
//   const alignedVWAP = vwap.slice(-minLength);
//   const alignedBoll = boll.slice(-minLength);
//   const alignedATR = atr.slice(-minLength);
//   const alignedVolume = volume.slice(offset);
//   const alignedVolumeEMA = volumeEMA.slice(-minLength);

//   // 获取最新值 minLength - 1（index=长度-1取最后一个数据）
//   const lastClose = alignedClose[minLength - 1];
//   const prevClose = alignedClose[minLength - 1];
//   const lastEma5 = alignedEma5[minLength - 1];
//   const lastEma13 = alignedEma13[minLength - 1];
//   const lastVWAP = alignedVWAP[minLength - 1];
//   const lastBoll = alignedBoll[minLength - 1];

//   const lastATR = alignedATR[minLength - 1];
//   const lastVolume = alignedVolume[minLength - 1];
//   const lastVolumeEMAValue = alignedVolumeEMA[minLength - 1];
//   const atrPercent = lastATR / lastClose;

//   const currentPrice = await getCurrentPrice(symbol);
//   const baseRatio = dynamicPriceRangeRatio(currentPrice, atr, config.baseRatio);

//   // ========== 趋势确认函数 ==========
//   const trendConfirmation = (values, period) => {
//     const changes = [];
//     for (let i = 1; i <= period; i++) {
//       changes.push(values[values.length - i] > values[values.length - i - 1]);
//     }
//     // 改为60%或使用加权确认
//     return changes.filter(x => x).length >= Math.floor(period * 0.6);
//   };

//   // ========== 改进的成交量判断 ==========
//   const volumeRatio = lastVolume / avgVolume;
//   const volumeEMARatio = lastVolume / lastVolumeEMAValue;
//   /**
//    * volumeRatio > 1.5（成交量比前一根增长50%）
//    * volumeEMARatio > 1.5（成交量比EMA均线增长50%）
//    * lastVolume > avgVolume + 1.5 * volumeStdDev（成交量超过均值+1.5倍标准差）
//    */
//   const isVolumeSpike =
//     (volumeRatio > 1.3 || volumeEMARatio > 1.3) ||  // 从 1.5 → 1.3（30% 增长）
//     lastVolume > avgVolume + 1.0 * volumeStdDev;    // 从 1.5 → 1.0（更敏感）
//   const isVolumeDecline =
//     (volumeRatio < 0.9 || volumeEMARatio < 0.9) ||  // 从 0.85 → 0.9（10% 萎缩）
//     lastVolume < avgVolume - 1.0 * volumeStdDev;    // 从 1.5 → 1.0（更敏感）

//   // 成交量趋势判断
//   const volumeTrendUp = trendConfirmation(alignedVolume, 3);
//   const volumeTrendDown = trendConfirmation(alignedVolume.map(x => -x), 3);

//   // ========== 横盘震荡过滤 ==========
//   const flat = isFlatMarket({ close, high, low }, 0.005, baseRatio);
//   if (flat) {
//     log(`🚫 ${symbol} 横盘震荡过滤`);
//     return null;
//   }

//   const uptrendConfirmed = trendConfirmation(alignedClose, 5);
//   const downtrendConfirmed = trendConfirmation(alignedClose.map(x => -x), 5);

//   // ========== 波动性和成交量过滤 ==========
//   if (atrPercent < 0.002) {
//     log(`🚫 ${symbol} 波动性太小(ATR=${atrPercent.toFixed(4)})`);
//     return null;
//   }

//   if (isVolumeDecline) {
//     log(`🚫 ${symbol} 成交量不足(当前=${lastVolume}, 平均=${avgVolume.toFixed(2)}, EMA=${lastVolumeEMAValue.toFixed(2)}, 标准差=${volumeStdDev.toFixed(2)})`);
//     return null;
//   }

//   // ========== 时间过滤 ==========
//   const now = new Date();
//   const hours = now.getHours();
//   const minutes = now.getMinutes();

//   // if ((hours >= 1 && hours < 5) || (hours === 12 && minutes >= 30)) {
//   //   log(`🚫 ${symbol} 当前时段流动性不足`);
//   //   return null;
//   // }

//   // ========== 改进后的打分逻辑 ==========
//   let longScore = 0;
//   let shortScore = 0;

//   // 基础条件
//   if (lastClose > lastVWAP) longScore += 0.5;
//   if (lastEma5 > lastEma13) longScore += 0.5;
//   if (lastClose > lastBoll.middle) longScore += 0.5;

//   if (lastClose < lastVWAP) shortScore += 0.5;
//   if (lastEma5 < lastEma13) shortScore += 0.5;
//   if (lastClose < lastBoll.middle) shortScore += 0.5;

//   // 根据ATR百分比动态调整阈值
//   // const atrBasedThreshold = lastATR / lastClose * 1.5;  // 例如：2倍ATR百分比
//   // 结合波动率和时间周期
//   const baseFactor = 1.5; // 基础倍数
//   const volatilityAdjustment = (lastATR / lastClose) * 100; // ATR占比百分比
//   const dynamicFactor = baseFactor + volatilityAdjustment / 50; // 每1%波动率增加0.02倍

//   const atrBasedThreshold = lastATR * Math.min(dynamicFactor, 2.5); // 不超过2.5倍
//   // 强势条件(权重更高)
//   if (lastClose > lastBoll.upper && isVolumeSpike && volumeTrendUp) longScore += 2;
//   if (lastClose < lastBoll.lower && isVolumeSpike && volumeTrendDown) shortScore += 2;
//   if (lastEma5 - lastEma13 > atrBasedThreshold && uptrendConfirmed && volumeTrendUp) longScore += 1;
//   if (lastEma13 - lastEma5 > atrBasedThreshold && downtrendConfirmed && volumeTrendDown) shortScore += 1;

//   // log(`✅ ${symbol}: (lastClose: ${lastClose} lastVWAP: ${lastVWAP} lastBoll.middle: ${lastBoll.middle} lastBoll.lower: ${lastBoll.lower} volumeTrendDown:${volumeTrendDown})`);
//   // log(`✅ ${symbol}: (lastClose: ${lastClose} lastBoll.upper: ${lastBoll.upper} isVolumeSpike: ${isVolumeSpike} volumeTrendUp: ${volumeTrendUp})`);
//   // log(`✅ ${symbol}: (lastEma5: ${lastEma5} lastEma13: ${lastEma13} atrBasedThreshold: ${atrBasedThreshold} downtrendConfirmed: ${downtrendConfirmed} uptrendConfirmed: ${uptrendConfirmed} )`);

//   // ========== 最终信号选择 ==========
//   const threshold = 3;
//   let signal = null;
//   let score = 0;
//   // log(`✅ ${symbol}: (得分: longScore-${longScore} shortScore-${shortScore})`);
//   if (longScore >= threshold && longScore >= shortScore) {
//     signal = 'LONG';
//     score = longScore;
//   } else if (shortScore >= threshold) {
//     signal = 'SHORT';
//     score = shortScore;
//   }

//   if (!signal) return null;

//   // 记录详细信息
//   log(`✅ ${symbol}: ${signal} (得分: ${score})`);
//   log(`  收盘价: ${lastClose.toFixed(4)} | EMA5: ${lastEma5.toFixed(4)} | EMA13: ${lastEma13.toFixed(4)}`);
//   log(`  VWAP: ${lastVWAP.toFixed(4)} | 布林带: ${lastBoll.middle.toFixed(4)} [${lastBoll.lower.toFixed(4)}, ${lastBoll.upper.toFixed(4)}]`);
//   log(`  成交量: ${lastVolume.toFixed(2)} (平均=${avgVolume.toFixed(2)}, EMA=${lastVolumeEMAValue.toFixed(2)}, 标准差=${volumeStdDev.toFixed(2)})`);
//   log(`  ATR: ${lastATR.toFixed(4)} (${(atrPercent * 100).toFixed(2)}%) | 成交量趋势: ${volumeTrendUp ? '↑' : volumeTrendDown ? '↓' : '→'}`);

//   return {
//     symbol,
//     side: signal,
//     score,
//     price: lastClose,
//     indicators: {
//       ema5: lastEma5,
//       ema13: lastEma13,
//       vwap: lastVWAP,
//       bollinger: lastBoll,
//       atr: lastATR,
//       volume: lastVolume,
//       avgVolume,
//       volumeEMA: lastVolumeEMAValue,
//       volumeStdDev,
//       volumeTrend: volumeTrendUp ? 'up' : volumeTrendDown ? 'down' : 'neutral'
//     }
//   };
// }

async function evaluateSymbolWithScore(symbol, interval = '15m') {
  // 获取K线数据（保留最后100根完整K线）
  const klines = (await fetchKlines(symbol, interval, 101)).slice(0, -1);
  const lastKline = klines[klines.length - 1];

  if (!klines || klines.length < 50) return null;

  // ========== 数据准备 ==========
  const close = klines.map(k => Number(k.close)).filter(v => !isNaN(v));
  const high = klines.map(k => Number(k.high)).filter(v => !isNaN(v));
  const low = klines.map(k => Number(k.low)).filter(v => !isNaN(v));
  const volume = klines.map(k => Number(k.volume)).filter(v => !isNaN(v));
  const quoteVolume = klines.map(k => Number(k.quoteVolume)).filter(v => !isNaN(v));

  // ========== 参数配置（15分钟专用）==========
  const CONFIG = {
    emaFastPeriod: 9,      // 约2.25小时
    emaSlowPeriod: 21,     // 约5小时
    bollPeriod: 26,        // 约6.5小时
    bollStdDev: 2.2,
    atrPeriod: 14,
    volumeEMAPeriod: 26,
    trendConfirmPeriod: 8, // 2小时确认
    minATRPercent: 0.003,  // 波动率阈值
    minNotional: 50000,    // 最小成交额5万USD
    adxThreshold: 25       // 趋势强度阈值
  };

  // ========== 指标计算 ==========
  // 核心指标
  const emaFast = EMA.calculate({ period: CONFIG.emaFastPeriod, values: close });
  const emaSlow = EMA.calculate({ period: CONFIG.emaSlowPeriod, values: close });
  const boll = BollingerBands.calculate({
    period: CONFIG.bollPeriod,
    values: close,
    stdDev: CONFIG.bollStdDev
  });
  const vwap = getVWAP(close, high, low, volume);
  const atr = calculateATR(klines, CONFIG.atrPeriod);
  const adx = calculateADX(klines, CONFIG.atrPeriod); // 需自行实现ADX计算

  // 成交量指标
  const avgVolume = volume.slice(-CONFIG.volumeEMAPeriod).reduce((a, b) => a + b, 0) / CONFIG.volumeEMAPeriod;
  const volumeEMA = EMA.calculate({ period: CONFIG.volumeEMAPeriod, values: volume });
  const volumeStdDev = Math.sqrt(
    volume.slice(-CONFIG.volumeEMAPeriod)
      .reduce((sum, vol) => sum + Math.pow(vol - avgVolume, 2), 0) / CONFIG.volumeEMAPeriod
  );

  // ========== 数据对齐 ==========
  const minLength = Math.min(
    emaFast.length, emaSlow.length,
    boll.length, vwap.length,
    atr.length, volumeEMA.length
  );
  if (minLength < 2) {
    log(`❌ ${symbol} 指标长度不足`);
    return null;
  }

  const offset = close.length - minLength;
  const alignedClose = close.slice(offset);
  const alignedEmaFast = emaFast.slice(-minLength);
  const alignedEmaSlow = emaSlow.slice(-minLength);
  const alignedVWAP = vwap.slice(-minLength);
  const alignedBoll = boll.slice(-minLength);
  const alignedATR = atr.slice(-minLength);
  const alignedVolume = volume.slice(offset);
  const alignedVolumeEMA = volumeEMA.slice(-minLength);

  // ========== 获取最新值 ==========
  const last = {
    close: alignedClose[minLength - 1],
    prevClose: alignedClose[minLength - 2],
    emaFast: alignedEmaFast[minLength - 1],
    emaSlow: alignedEmaSlow[minLength - 1],
    vwap: alignedVWAP[minLength - 1],
    boll: alignedBoll[minLength - 1],
    atr: alignedATR[minLength - 1],
    volume: alignedVolume[minLength - 1],
    volumeEMA: alignedVolumeEMA[minLength - 1],
    quoteVolume: quoteVolume[quoteVolume.length - 1]
  };

  const atrPercent = last.atr / last.close;
  const currentPrice = await getCurrentPrice(symbol);
  const baseRatio = dynamicPriceRangeRatio(currentPrice, atr, config.baseRatio);

  // ========== 增强过滤系统 ==========
  // 1. 流动性过滤
  if (last.quoteVolume < CONFIG.minNotional) {
    log(`🚫 ${symbol} 成交额不足($${last.quoteVolume.toFixed(0)})`);
    return null;
  }

  // 2. 波动性过滤
  if (atrPercent < CONFIG.minATRPercent) {
    log(`🚫 ${symbol} 波动性不足(ATR=${atrPercent.toFixed(4)})`);
    return null;
  }

  // 3. 趋势强度过滤
  if (adx < CONFIG.adxThreshold) {
    log(`🚫 ${symbol} 趋势强度不足(ADX=${adx.toFixed(1)})`);
    return null;
  }

  // 4. K线实体过滤
  const validCandles = klines.slice(-3).filter(k => {
    const body = Math.abs(k.close - k.open);
    return body > last.atr * 0.3;
  });
  if (validCandles.length < 2) {
    log(`🚫 ${symbol} K线实体不足`);
    return null;
  }

  // 5. 横盘过滤
  if (isFlatMarket({ close, high, low }, 0.004, baseRatio)) { // 比3分钟更严格
    log(`🚫 ${symbol} 横盘震荡过滤`);
    return null;
  }

  // ========== 趋势判断系统 ==========
  const trendConfirmation = (values, period) => {
    const changes = values.slice(-period - 1)
      .map((v, i, arr) => i > 0 ? v > arr[i - 1] : false)
      .filter(Boolean);
    return changes.length >= Math.floor(period * 0.75); // 75%确认率
  };

  const uptrendConfirmed = trendConfirmation(alignedClose, CONFIG.trendConfirmPeriod);
  const downtrendConfirmed = trendConfirmation(alignedClose.map(x => -x), CONFIG.trendConfirmPeriod);

  // ========== 成交量分析 ==========
  const volumeRatio = last.volume / avgVolume;
  const volumeEMARatio = last.volume / last.volumeEMA;

  const isVolumeSpike =
    (volumeRatio > 2.0 || volumeEMARatio > 1.8) &&
    (last.volume > avgVolume + 1.8 * volumeStdDev);

  const volumeTrendUp = trendConfirmation(alignedVolume, 5);
  const volumeTrendDown = trendConfirmation(alignedVolume.map(x => -x), 5);

  // ========== 动态评分系统 ==========
  let longScore = 0;
  let shortScore = 0;

  // 基础条件（每项0.5分）
  if (last.close > last.vwap) longScore += 0.5;
  if (last.emaFast > last.emaSlow) longScore += 0.5;
  if (last.close > last.boll.middle) longScore += 0.5;

  if (last.close < last.vwap) shortScore += 0.5;
  if (last.emaFast < last.emaSlow) shortScore += 0.5;
  if (last.close < last.boll.middle) shortScore += 0.5;

  // 强势条件（动态权重）
  const bollBreakoutRatio = (last.close - last.boll.upper) / last.atr;
  if (bollBreakoutRatio > 0.5 && isVolumeSpike && volumeTrendUp) longScore += 2.5; // 原2→2.5

  const bollBreakdownRatio = (last.boll.lower - last.close) / last.atr;
  if (bollBreakdownRatio > 0.5 && isVolumeSpike && volumeTrendDown) shortScore += 2.5;

  // EMA差值条件（动态阈值）
  const emaDiff = last.emaFast - last.emaSlow;
  const dynamicThreshold = last.atr * (2.0 + (adx - 25) / 50); // ADX加权

  if (emaDiff > dynamicThreshold && uptrendConfirmed) longScore += 1.2; // 原1→1.2
  if (emaDiff < -dynamicThreshold && downtrendConfirmed) shortScore += 1.2;

  // ========== 高阶周期确认 ==========
  try {
    const higherTF = await fetchKlines(symbol, '4h', 10);
    const higherClose = higherTF.map(k => Number(k.close));
    const higherTrend = trendConfirmation(higherClose, 5);

    // 方向一致加分
    if (longScore > 0 && higherTrend) longScore += 0.8;
    if (shortScore > 0 && !higherTrend) shortScore += 0.8;
  } catch (e) {
    log(`⚠️ ${symbol} 高阶周期获取失败: ${e.message}`);
  }

  // ========== 时段调整 ==========
  const now = new Date();
  const hours = now.getHours();
  const isPeakHour = [8, 12, 16, 20].includes(hours);
  const threshold = isPeakHour ? 3.8 : 4.2; // 活跃时段更严格

  // ========== 最终信号 ==========
  let signal = null;
  let score = 0;

  if (longScore >= threshold && longScore >= shortScore) {
    signal = 'LONG';
    score = longScore;
  } else if (shortScore >= threshold) {
    signal = 'SHORT';
    score = shortScore;
  }

  if (!signal) return null;

  // ========== 结果输出 ==========
  log(`✅ [15m] ${signal} ${symbol} (得分: ${score.toFixed(1)})`);
  log(`  📊 价格: ${last.close.toFixed(4)} | EMA: ${last.emaFast.toFixed(4)}/${last.emaSlow.toFixed(4)}`);
  log(`  📈 波段: ${last.boll.lower.toFixed(4)}-${last.boll.upper.toFixed(4)} | VWAP: ${last.vwap.toFixed(4)}`);
  log(`  🌊 波动: ATR ${last.atr.toFixed(4)} (${(atrPercent * 100).toFixed(2)}%) | ADX: ${adx.toFixed(1)}`);
  log(`  🚀 成交量: ${last.volume.toFixed(0)} (${(volumeRatio * 100).toFixed(0)}%均线)`);

  return {
    symbol,
    interval,
    side: signal,
    score: parseFloat(score.toFixed(2)),
    price: last.close,
    indicators: {
      emaFast: last.emaFast,
      emaSlow: last.emaSlow,
      vwap: last.vwap,
      bollinger: last.boll,
      atr: last.atr,
      adx,
      volume: last.volume,
      volumeRatio,
      volumeTrend: volumeTrendUp ? 'up' : volumeTrendDown ? 'down' : 'neutral',
      higherTFConfirm: signal === 'LONG' ? 'bullish' : 'bearish'
    },
    timestamps: {
      analysisTime: new Date().toISOString(),
      klineCloseTime: new Date(lastKline.closeTime).toISOString()
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

// 遍历多个币种，返回 topN 的多头和空头
async function getTopLongShortSymbolsTest(symbolList, topN = 3, interval) {
  const longList = [];
  const shortList = [];

  for (const symbol of symbolList) {
    try {
      const res = await evaluateSymbolWithScore(symbol, interval);
      if (!res) continue;
      if (res?.side === 'LONG') longList.push(res);
      if (res?.side === 'SHORT') shortList.push(res);
    } catch (err) {
      log(`❌ ${symbol} 评估失败: ${err.message}`);
    }
  }
  // todo
  const topLong = longList.sort((a, b) => b.score - a.score);
  const topShort = shortList.sort((a, b) => b.score - a.score);
  return { topLong, topShort };
}

module.exports = { getTopLongShortSymbols, getTopLongShortSymbolsTest };
