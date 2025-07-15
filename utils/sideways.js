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

  let sidewaysDuration = 0;

  for (let i = closePrices.length - minSidewaysDuration; i < closePrices.length; i++) {
    const subCloses = closePrices.slice(i - priceStdPeriod, i);
    const subBolls = boll.slice(i - priceStdPeriod, i);

    if (subCloses.length < priceStdPeriod || subBolls.length < priceStdPeriod) continue;

    const avg = subCloses.reduce((a, b) => a + b, 0) / subCloses.length;
    const std = Math.sqrt(subCloses.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / subCloses.length);
    const stdRate = std / avg;

    const bollWidths = subBolls.map(b => (b.upper - b.lower) / b.middle);
    const avgBollWidth = bollWidths.reduce((a, b) => a + b, 0) / bollWidths.length;

    if (stdRate < priceStdThreshold && avgBollWidth < bollNarrowThreshold) {
      sidewaysDuration++;
    } else {
      sidewaysDuration = 0;
    }
  }

  if (sidewaysDuration >= minSidewaysDuration) {
    return {
      sideways: true,
      reason: `横盘止盈：低波动持续 ${sidewaysDuration} 根K线`
    };
  }

  return { sideways: false };
}

module.exports = { isSideways };
