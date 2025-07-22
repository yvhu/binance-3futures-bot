function isFlatMarket({ close, high, low }, atrThreshold = 0.005, priceRangeRatio = 0.01) {
  const recentClose = close.slice(-20);
  const recentHigh = high.slice(-20);
  const recentLow = low.slice(-20);

  const maxPrice = Math.max(...recentHigh);
  const minPrice = Math.min(...recentLow);
  const priceRange = maxPrice - minPrice;
  const avgClose = recentClose.reduce((a, b) => a + b, 0) / recentClose.length;

  const rangeRatio = priceRange / avgClose;

  return rangeRatio < priceRangeRatio;  // 横盘区间非常窄
}

function dynamicPriceRangeRatio(currentPrice, atr14, baseRatio) {
  // const baseRatio = 0.003; // 基础阈值
  const atrRatio = atr14 / currentPrice;
  return baseRatio * (1 + atrRatio); // 波动大的品种放宽阈值
}

module.exports = {
  isFlatMarket,
  dynamicPriceRangeRatio
};