// 引入技术指标库中的 EMA 与 BollingerBands
const { EMA, BollingerBands } = require('technicalindicators');
const axios = require('axios');
const config = require('../config/config');

// 获取指定币种的 K 线数据（默认获取 50 根）
async function fetchKlines(symbol, interval, limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await axios.get(url);

  return response.data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

// 是否连续出现 N 根阴线
function countRedCandles(klines, count) {
  return klines.slice(-count).every(k => k.close < k.open);
}

// 判断单根K线是否为阴线
function isRedCandle(k) {
  return k.close < k.open;
}

// 判断最近N根K线是否全部为阴线
function countRedCandles(klines, n) {
  return klines.slice(-n).every(isRedCandle);
}

// 分析某币种在指定周期下的交易信号（是否应做多 / 做空）
/**
 * 分析单个币种的多空信号（基于 EMA 金叉/死叉 + BOLL 中轴过滤 + 连续阴线惩罚）
 */
async function analyzeSymbol(symbol, interval) {
  // ====== 计算所需K线数量：确保足够覆盖所有指标的周期需求 ======
  const limit = Math.max(
    config.ema.longPeriod + 5,
    config.bb.period + 5,
    config.maxRedCandles + 5,
    50
  );

  // 获取历史K线数据
  const klines = await fetchKlines(symbol, interval, limit);
  if (klines.length < limit) return { shouldLong: false, shouldShort: false, score: -999 };

  // 只提取收盘价数组用于技术指标计算
  const closes = klines.map(k => k.close);

  // ====== 计算 EMA（短期 & 长期）用于识别金叉/死叉 ======
  const emaShort = EMA.calculate({ period: config.ema.shortPeriod, values: closes });
  const emaLong = EMA.calculate({ period: config.ema.longPeriod, values: closes });

  // ====== 计算布林带指标（中轨用于中轴判断） ======
  const bb = BollingerBands.calculate({
    period: config.bb.period,
    stdDev: config.bb.stdDev,
    values: closes
  });

  // 金叉/死叉后 N 根K线内视为有效信号（默认3根）
  const recentCandles = config.signalValidCandles || 3;

  let shouldLong = false;
  let shouldShort = false;

  // ====== 遍历历史 EMA，查找最近一组 金叉 or 死叉 ======
  let crossIndex = -1;
  let isCrossUp = false;
  let isCrossDown = false;

  for (let i = emaLong.length - recentCandles - 1; i >= 1; i--) {
    const prevShort = emaShort[i - 1];
    const prevLong = emaLong[i - 1];
    const currShort = emaShort[i];
    const currLong = emaLong[i];

    if (prevShort < prevLong && currShort > currLong) {
      // 发生金叉
      crossIndex = i;
      isCrossUp = true;
      break;
    }

    if (prevShort > prevLong && currShort < currLong) {
      // 发生死叉
      crossIndex = i;
      isCrossDown = true;
      break;
    }
  }

  // ====== 如果出现了金叉/死叉，再进行布林中轴判断 ======
  if (crossIndex !== -1) {
    // 找到金叉/死叉发生时的价格和布林中轴
    const crossClose = closes[closes.length - emaLong.length + crossIndex];
    const crossBB = bb[bb.length - emaLong.length + crossIndex];
    const basis = crossBB.middle;  // 中轴线（布林中轨）

    const currentIndex = emaLong.length - 1;

    // 判断当前K线是否仍处于金叉/死叉后的有效期（N根K线内）
    const withinRecentCandles = (currentIndex - crossIndex) <= recentCandles;

    // 满足：金叉 + 当时K线在中轴上方 + 当前仍在有效范围内
    if (isCrossUp && crossClose >= basis && withinRecentCandles) {
      shouldLong = true;
    }

    // 满足：死叉 + 当时K线在中轴下方 + 当前仍在有效范围内
    if (isCrossDown && crossClose <= basis && withinRecentCandles) {
      shouldShort = true;
    }
  }

  // ====== 连续阴线过滤（防止逆势追单）======
  const redCandleHit = countRedCandles(klines, config.maxRedCandles);

  // ====== 综合评分（可拓展机制）======
  let score = 0;
  if (shouldLong || shouldShort) score += 1;       // 出现有效方向信号加分
  if (redCandleHit) score -= 1;                    // 若处于连续阴线状态则减分（弱势）

  // 返回综合判断结果
  return { shouldLong, shouldShort, score };
}


module.exports = {
  analyzeSymbol
};
