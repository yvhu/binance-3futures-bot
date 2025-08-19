// 引入技术指标库中的 EMA 与 BollingerBands
const { EMA, BollingerBands } = require('technicalindicators');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { countRedCandles, countGreenCandles } = require('../utils/filters')

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

/**
 * 分析某币种是否具备做多或做空信号
 * @param {string} symbol - 币种，例如 BTCUSDT
 * @param {string} interval - 周期，例如 '3m'
 * @returns {object} { shouldLong, shouldShort, score }
 */
async function analyzeSymbol(symbol, interval) {
  log(`🔍 分析币种: ${symbol}, 周期: ${interval}`);

  // === 获取足够的K线数据，确保覆盖所有指标周期 ===
  const limit = Math.max(
    config.ema.longPeriod + 5,
    config.bb.period + 5,
    config.maxRedOrGreenCandles + 5,
    50
  );
  // 获取K线数据并排除最后一条可能未完成的
  const klines = (await fetchKlines(symbol, interval, limit + 1)).slice(0, -1);
  // const klines = await fetchKlines(symbol, interval, limit); // 拉取足够的历史K线

  if (klines.length < limit) {
    log(`⚠️ 获取K线不足 ${limit} 条，实际只有 ${klines.length}，跳过分析`);
    return { shouldLong: false, shouldShort: false, score: -999 };
  }

  // 提取收盘价数组
  const closes = klines.map(k => k.close);

  // === 计算 EMA 短期与长期，用于判断金叉/死叉 ===
  const emaShort = EMA.calculate({ period: config.ema.shortPeriod, values: closes });
  const emaLong = EMA.calculate({ period: config.ema.longPeriod, values: closes });

  // === 计算布林带中轨线（用于验证金叉/死叉的位置） ===
  const bb = BollingerBands.calculate({
    period: config.bb.period,
    stdDev: config.bb.stdDev,
    values: closes
  });

  const recentCandles = config.signalValidCandles || 3;
  let shouldLong = false;
  let shouldShort = false;
  log(`🔄 检测到金叉+连续阴线 或 死叉+连续阳线，判定为震荡，信号作废`);

  // === 查找最近的金叉或死叉信号 ===
  let crossIndex = -1;
  let crossType = null; // 'golden' or 'death'

  log(`📊 查找最近 ${recentCandles} 根K线内的金叉或死叉`);

  for (let i = emaLong.length - 1; i >= emaLong.length - recentCandles; i--) {
    const prevShort = emaShort[i - 1];
    const prevLong = emaLong[i - 1];
    const currShort = emaShort[i];
    const currLong = emaLong[i];

    if (prevShort < prevLong && currShort > currLong) {
      crossIndex = i;
      crossType = 'golden';
      log(`🟢 最近金叉: index=${i}, EMA短=${currShort.toFixed(6)}, EMA长=${currLong.toFixed(6)}`);
      break;
    }

    if (prevShort > prevLong && currShort < currLong) {
      crossIndex = i;
      crossType = 'death';
      log(`🔴 最近死叉: index=${i}, EMA短=${currShort.toFixed(6)}, EMA长=${currLong.toFixed(6)}`);
      break;
    }
  }

  // === 若检测到金叉/死叉，进一步判断是否满足中轴要求 ===
  if (crossIndex !== -1) {
    const offset = closes.length - emaLong.length + crossIndex;
    const crossClose = closes[offset];
    const crossBB = bb[bb.length - emaLong.length + crossIndex];
    const basis = crossBB.middle;

    const currentIndex = emaLong.length - 1;
    const withinRecentCandles = (currentIndex - crossIndex) <= recentCandles;

    log(`🔎 交叉中轴判断: close=${crossClose}, basis=${basis}, 有效期内=${withinRecentCandles}`);

    if (crossType === 'golden' && crossClose >= basis && withinRecentCandles) {
      shouldLong = true;
      log(`✅ 做多条件满足：金叉 + 上穿中轴 + 在 ${recentCandles} 根K线内`);
    }

    if (crossType === 'death' && crossClose <= basis && withinRecentCandles) {
      shouldShort = true;
      log(`✅ 做空条件满足：死叉 + 下穿中轴 + 在 ${recentCandles} 根K线内`);
    }
  } else {
    log(`⚠️ 未检测到金叉或死叉`);
  }

  // === 连续阴线过滤逻辑（防止逆势追多）===
  const redCandleHit = countRedCandles(klines, config.maxRedOrGreenCandles);
  const greenCandleHit = countGreenCandles(klines, config.maxRedOrGreenCandles);
  if (redCandleHit) {
    log(`⚠️ 连续出现 ${config.maxRedOrGreenCandles}+ 根阴线`);
  }
  if (greenCandleHit) {
    log(`⚠️ 连续出现 ${config.maxRedOrGreenCandles}+ 根阳线`);
  }

  // === 新增逻辑：若金叉 + 连续阴线，或 死叉 + 连续阳线，认为为震荡行情 ===
  if ((shouldLong && redCandleHit) || (shouldShort && greenCandleHit)) {
    shouldLong = false;
    shouldShort = false;
    log(`🔄 检测到金叉+连续阴线 或 死叉+连续阳线，判定为震荡，信号作废`);
  }

  // === 综合得分机制，可扩展 ===
  let score = 0;
  if (shouldLong || shouldShort) score += 1;
  if (shouldLong && redCandleHit) score -= 1;
  if (shouldShort && greenCandleHit) score -= 1;

  return { shouldLong, shouldShort, score };
}

module.exports = {
  analyzeSymbol,
};
