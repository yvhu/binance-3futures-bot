const { log } = require('../utils/logger');
/**
 * 判断是否处于横盘震荡状态（结合价格标准差 + 布林带宽度 + 横盘持续时间）
 * @param {Array<number>} closePrices - 收盘价数组（至少 N + period 条）
 * @param {Array<object>} boll - BollingerBands数组 [{ upper, lower, middle }]
 * @param {object} config - 横盘判断配置项
 * @returns {{ sideways: boolean, reason: string }}
 */
function isSideways(closePrices, boll, config) {
  const {
    priceStdPeriod = 10,
    priceStdThreshold = 0.002,
    bollNarrowPeriod = 10,
    bollNarrowThreshold = 0.01,
    minSidewaysDuration = 6
  } = config;

  // 首先检查数据长度是否足够
  const requiredLength = priceStdPeriod + minSidewaysDuration;
  if (closePrices.length < requiredLength || boll.length < requiredLength) {
    return {
      sideways: false,
      reason: `数据不足(需要${requiredLength}根K线，当前${closePrices.length})`
    };
  }

  let sidewaysDuration = 0;
  let lastReason = "";

  for (let i = closePrices.length - minSidewaysDuration; i < closePrices.length; i++) {
    const subCloses = closePrices.slice(i - priceStdPeriod, i);
    const subBolls = boll.slice(i - priceStdPeriod, i);
    // 调试日志：检查布林带数据
    log(`检查布林带数据:`, subBolls.map(b => ({
      upper: b.upper,
      lower: b.lower,
      middle: b.middle,
      isValid: !isNaN(b.upper) && !isNaN(b.lower) && !isNaN(b.middle) && b.middle !== 0
    })));

    const avg = subCloses.reduce((a, b) => a + b, 0) / subCloses.length;
    const std = Math.sqrt(subCloses.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / subCloses.length);
    const stdRate = std / avg;

    const bollWidths = subBolls.map(b => (b.upper - b.lower) / b.middle);
    const avgBollWidth = bollWidths.reduce((a, b) => a + b, 0) / bollWidths.length;

    log(`avgBollWidth: ${avgBollWidth} bollWidths： ${bollWidths}`);
    if (stdRate < priceStdThreshold && avgBollWidth < bollNarrowThreshold) {
      sidewaysDuration++;
      lastReason = `符合横盘条件(波动率${stdRate.toFixed(6)}<${priceStdThreshold}, 布林带宽${avgBollWidth.toFixed(6)}<${bollNarrowThreshold})`;
    } else {
      lastReason = `不符合横盘条件(波动率${stdRate.toFixed(6)}>=${priceStdThreshold} 或 布林带宽${avgBollWidth.toFixed(6)}>=${bollNarrowThreshold})`;
      sidewaysDuration = 0;
      // 可以添加调试日志
      // console.log(`K线${i}: ${lastReason}`);
    }
  }

  if (sidewaysDuration >= minSidewaysDuration) {
    return {
      sideways: true,
      reason: `横盘止盈：低波动持续 ${sidewaysDuration} 根K线`
    };
  }

  return {
    sideways: false,
    reason: lastReason || "未达到横盘持续时间要求"
  };
}

module.exports = { isSideways };
