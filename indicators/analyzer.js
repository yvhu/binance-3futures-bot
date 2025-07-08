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

// 判断单根K线是否为阴线
function isRedCandle(k) {
  return k.close < k.open;
}

// 判断最近N根K线是否全部为阴线
function countRedCandles(klines, n) {
  return klines.slice(-n).every(isRedCandle);
}

// 分析某币种在指定周期下的交易信号（是否应做多 / 做空）
async function analyzeSymbol(symbol, interval) {
  // 获取近30根K线（用于计算指标）
  const klines = await fetchKlines(symbol, interval, 30);
  const closes = klines.map(k => k.close); // 收盘价数组

  // 计算短期和长期EMA（7日、21日）
  const emaShort = EMA.calculate({ period: 7, values: closes });
  const emaLong = EMA.calculate({ period: 21, values: closes });

  const lastEmaShort = emaShort[emaShort.length - 1];
  const lastEmaLong = emaLong[emaLong.length - 1];
  const prevEmaShort = emaShort[emaShort.length - 2];
  const prevEmaLong = emaLong[emaLong.length - 2];

  // 计算布林带指标（20周期、2倍标准差）
  const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const lastBB = bb[bb.length - 1];
  const lastClose = closes[closes.length - 1];

  // 判断是否突破布林带上下轨
  const isBreakUpper = lastClose > lastBB.upper;
  const isBreakLower = lastClose < lastBB.lower;

  // 判断是否为 EMA 金叉/死叉
  const isCrossUp = prevEmaShort < prevEmaLong && lastEmaShort > lastEmaLong;     // 金叉（做多信号）
  const isCrossDown = prevEmaShort > prevEmaLong && lastEmaShort < lastEmaLong;   // 死叉（做空信号）

  // 判断是否连续出现N根阴线
  const redCandleHit = countRedCandles(klines, config.maxRedCandles);

  // 综合信号判断
  const shouldLong = isCrossUp && isBreakUpper;   // 满足金叉+上穿布林带 => 做多
  const shouldShort = isCrossDown && isBreakLower; // 满足死叉+下破布林带 => 做空

  // 简单评分机制：+1代表强信号，-1代表被连续阴线惩罚
  const score = (shouldLong || shouldShort ? 1 : 0) + (redCandleHit ? -1 : 0);

  return { shouldLong, shouldShort, score };
}

module.exports = {
  analyzeSymbol
};
