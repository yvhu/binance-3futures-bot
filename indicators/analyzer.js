// 引入技术指标库中的 EMA 与 BollingerBands
const { EMA, BollingerBands } = require('technicalindicators');
const axios = require('axios');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { getPosition } = require('../utils/position');
const { countRedCandles, countGreenCandles } = require('../utils/filters')

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
  if (redCandleHit) score -= 1;

  return { shouldLong, shouldShort, score };
}

// 分析平仓信号和analyzeSymbol 多空信号做区分
async function shouldCloseByExitSignal(symbol, interval) {
  log(`🔍 分析币种: ${symbol}, 周期: ${interval}`);

  // === 拉取足够的K线数量，供指标计算 ===
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

  const closes = klines.map(k => k.close);

  // === 指标计算 ===
  const emaShort = EMA.calculate({ period: config.ema.shortPeriod, values: closes });
  const emaLong = EMA.calculate({ period: config.ema.longPeriod, values: closes });
  const bb = BollingerBands.calculate({
    period: config.bb.period,
    stdDev: config.bb.stdDev,
    values: closes
  });

  const continuousCount = config.continuousKlineCount || 2;
  let shouldLong = false;
  let shouldShort = false;

  // === 获取当前持仓信息 ===
  const position = getPosition(symbol);
  const currentSide = position?.side; // 'BUY' 或 'SELL'
  log(`📌 当前持仓方向: ${currentSide || '无'}`);

  let aboveCount = 0;   // 统计连续收盘价高于布林带中轨（basis）的次数
  let belowCount = 0;   // 统计连续收盘价低于布林带中轨（basis）的次数

  // 遍历最近 continuousCount 根K线
  const bbStartOffset = klines.length - bb.length;
  for (let i = klines.length - continuousCount; i < klines.length; i++) {
    const close = closes[i];
    const bbIndex = i - bbStartOffset;

    if (bbIndex < 0 || bbIndex >= bb.length) {
      log(`⚠️ bbIndex 越界: ${bbIndex}`);
      continue;
    }
    const basis = bb[bbIndex].middle;       // 当前K线对应的布林带中轨（需对齐bb数组索引）
    if (close >= basis) aboveCount++;       // 如果收盘价高于或等于中轨，增加 aboveCount
    if (close <= basis) belowCount++;       // 如果收盘价低于或等于中轨，增加 belowCount
  }


  // === 持仓是做多：连续收盘在中轨下方 → 平多做空
  if (currentSide === 'BUY' && belowCount === continuousCount) {
    shouldShort = true;
    log(`🔁 平多开空信号：连续 ${continuousCount} 根K线低于中轨`);
  }

  // === 持仓是做空：连续收盘在中轨上方 → 平空做多
  if (currentSide === 'SELL' && aboveCount === continuousCount) {
    shouldLong = true;
    log(`🔁 平空开多信号：连续 ${continuousCount} 根K线高于中轨`);
  }

  // === 配置涨跌幅阈值和比较的历史K线数量
  const priceChangeLookBack = config.priceChangeLookBack || 3;    // 比较多少根K线前的价格
  const priceChangeThreshold = config.priceChangeThreshold || 0.05; // 5%涨跌幅阈值

  if (klines.length > priceChangeLookBack) {
    const currentClose = closes[closes.length - 1];
    const compareClose = closes[closes.length - 1 - priceChangeLookBack];
    const changeRate = (currentClose - compareClose) / compareClose;

    log(`📈 价格变化率(${priceChangeLookBack}根K线): ${(changeRate * 100).toFixed(2)}%`);

    // 当前涨幅超过阈值，但持空，触发平空做多信号
    if (changeRate > priceChangeThreshold && currentSide === 'SELL') {
      shouldLong = true;
      shouldShort = false;
      log(`🔔 价格上涨超过${(priceChangeThreshold * 100)}%，持空 -> 触发平空做多`);
    }

    // 当前跌幅超过阈值，但持多，触发平多做空信号
    if (changeRate < -priceChangeThreshold && currentSide === 'BUY') {
      shouldShort = true;
      shouldLong = false;
      log(`🔔 价格下跌超过${(priceChangeThreshold * 100)}%，持多 -> 触发平多做空`);
    }
  }

  // === 阴阳线连续反转判断 ===
  const redGreenCount = config.maxRedOrGreenCandles || 3;

  if (!shouldLong && !shouldShort && klines.length >= redGreenCount) {
    let allRed = true;
    let allGreen = true;

    for (let i = klines.length - redGreenCount; i < klines.length; i++) {
      const k = klines[i];
      if (k.close >= k.open) allRed = false;   // 非红K线
      if (k.close <= k.open) allGreen = false; // 非绿K线
    }

    // 当前持仓做多，且最近N根都是红K（阴线） → 平多做空
    if (currentSide === 'BUY' && allRed) {
      shouldShort = true;
      log(`🔻 持多 → 检测到连续 ${redGreenCount} 根红K，触发反转做空`);
    }

    // 当前持仓做空，且最近N根都是绿K（阳线） → 平空做多
    if (currentSide === 'SELL' && allGreen) {
      shouldLong = true;
      log(`🟢 持空 → 检测到连续 ${redGreenCount} 根绿K，触发反转做多`);
    }
  }

  // === 若上述无信号，再检查最近 N 根K线内是否发生金叉或死叉 ===
  if (!shouldLong && !shouldShort && emaShort.length >= 2 && emaLong.length >= 2) {
    const crossCheckCount = config.signalValidCandles || 3; // 默认回看最近3根K线
    const start = Math.max(1, emaShort.length - crossCheckCount); // 避免越界

    for (let i = start; i < emaShort.length; i++) {
      const prevShort = emaShort[i - 1];
      const prevLong = emaLong[i - 1];
      const currShort = emaShort[i];
      const currLong = emaLong[i];

      if (prevShort < prevLong && currShort > currLong) {
        shouldLong = true;
        log(`🟢 最近 ${crossCheckCount} 根内检测到金叉：EMA短期上穿长期 (index=${i})`);
        break;
      }

      if (prevShort > prevLong && currShort < currLong) {
        shouldShort = true;
        log(`🔴 最近 ${crossCheckCount} 根内检测到死叉：EMA短期下穿长期 (index=${i})`);
        break;
      }
    }

    if (!shouldLong && !shouldShort) {
      log(`ℹ️ 最近 ${crossCheckCount} 根K线内未检测到金叉/死叉`);
    }
  }

  // === 综合评分，可扩展 ===
  let score = 0;
  if (shouldLong || shouldShort) score += 1;

  return { shouldLong, shouldShort, score };
}

module.exports = {
  analyzeSymbol,
  shouldCloseByExitSignal
};
