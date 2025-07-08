// 引入技术指标库中的 EMA 与 BollingerBands
const { EMA, BollingerBands } = require('technicalindicators');
const axios = require('axios');
const config = require('../config/config');
const { log } = require('../utils/logger');

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
    config.maxRedCandles + 5,
    50
  );
  const klines = await fetchKlines(symbol, interval, limit);

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
  const redCandleHit = countRedCandles(klines, config.maxRedCandles);
  if (redCandleHit) {
    log(`⚠️ 连续出现 ${config.maxRedCandles}+ 根阴线，信号无效`);
  }

  // === 综合得分机制，可扩展 ===
  let score = 0;
  if (shouldLong || shouldShort) score += 1;
  if (redCandleHit) score -= 1;

  return { shouldLong, shouldShort, score };
}

// 分析平仓信号和analyzeSymbol 多空信号做区分
async function shouldCloseByExitSignal(symbol, interval) {
  log(`🔍 分析币种: ${symbol}, 周期: ${interval}`);

  // === 计算所需K线数量，确保指标足够计算 ===
  const limit = Math.max(
    config.ema.longPeriod + 5,
    config.bb.period + 5,
    config.continuousKlineCount + 5,
    50
  );

  const klines = await fetchKlines(symbol, interval, limit);
  if (klines.length < limit) {
    log(`⚠️ 获取K线不足 ${limit} 条，实际只有 ${klines.length} 条，跳过分析`);
    return { shouldLong: false, shouldShort: false, score: -999 };
  }

  // 提取收盘价数组
  const closes = klines.map(k => k.close);

  // === 计算 EMA（短期 & 长期） ===
  const emaShort = EMA.calculate({ period: config.ema.shortPeriod, values: closes });
  const emaLong = EMA.calculate({ period: config.ema.longPeriod, values: closes });

  // === 计算布林带中轨线（basis） ===
  const bb = BollingerBands.calculate({
    period: config.bb.period,
    stdDev: config.bb.stdDev,
    values: closes
  });

  const continuousCount = config.continuousKlineCount || 2;

  let shouldLong = false;
  let shouldShort = false;

  // === 金叉/死叉判断，仅识别最近一次交叉类型（避免冲突） ===
  if (emaShort.length >= 2 && emaLong.length >= 2) {
    const lastIdx = emaLong.length - 1;
    const prevIdx = lastIdx - 1;

    const prevShort = emaShort[prevIdx];
    const prevLong = emaLong[prevIdx];
    const currShort = emaShort[lastIdx];
    const currLong = emaLong[lastIdx];

    const crossType = (() => {
      if (prevShort < prevLong && currShort > currLong) return 'golden';
      if (prevShort > prevLong && currShort < currLong) return 'death';
      return null;
    })();

    if (crossType === 'golden') {
      shouldLong = true;
      log(`🟢 检测到最近金叉：EMA短期由下向上穿越长期`);
    } else if (crossType === 'death') {
      shouldShort = true;
      log(`🔴 检测到最近死叉：EMA短期由上向下穿越长期`);
    } else {
      log(`⚠️ 当前和前一根K线未检测到有效交叉`);
    }
  } else {
    log('⚠️ EMA计算长度不足，跳过交叉判断');
  }

  // === 布林带中轨连续判断（在无交叉信号时启用） ===
  if (!shouldLong && !shouldShort) {
    const bbStartIndex = bb.length - klines.length;
    if (bbStartIndex < 0) {
      log('⚠️ 布林带结果长度与K线不匹配');
      return { shouldLong: false, shouldShort: false, score: 0 };
    }

    // 判断连续N根K线收盘价是否都在中轨线上方或下方
    // 连续在中轨线上方 => 做多信号
    // 连续在中轨线下方 => 做空信号
    let longCount = 0;
    let shortCount = 0;

    for (let i = klines.length - continuousCount; i < klines.length; i++) {
      const close = closes[i];
      const basis = bb[i - bbStartIndex].middle;

      if (close >= basis) longCount++;
      if (close <= basis) shortCount++;
    }

    if (longCount === continuousCount) {
      shouldLong = true;
      log(`✅ 连续 ${continuousCount} 根K线收盘价高于布林带中轨，触发做多信号`);
    } else if (shortCount === continuousCount) {
      shouldShort = true;
      log(`✅ 连续 ${continuousCount} 根K线收盘价低于布林带中轨，触发做空信号`);
    }
  }

  // === 简单评分机制（可拓展） ===
  let score = 0;
  if (shouldLong || shouldShort) score += 1;

  return { shouldLong, shouldShort, score };
}


module.exports = {
  analyzeSymbol,
  shouldCloseByExitSignal
};
