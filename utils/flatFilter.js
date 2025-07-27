// function isFlatMarket({ close, high, low }, atrThreshold = 0.005, priceRangeRatio = 0.01) {
//   const recentClose = close.slice(-20);
//   const recentHigh = high.slice(-20);
//   const recentLow = low.slice(-20);

//   const maxPrice = Math.max(...recentHigh);
//   const minPrice = Math.min(...recentLow);
//   const priceRange = maxPrice - minPrice;
//   const avgClose = recentClose.reduce((a, b) => a + b, 0) / recentClose.length;

//   const rangeRatio = priceRange / avgClose;

//   return rangeRatio < priceRangeRatio;  // 横盘区间非常窄
// }

function isFlatMarket({ close, high, low }, atrThreshold = 0.005, priceRangeRatio = 0.01) {
  // 参数说明：
  // atrThreshold: ATR波动率阈值（默认0.5%）
  // priceRangeRatio: 价格波动范围阈值（默认1%）

  if (close.length < 20) return false; // 最少需要20根K线

  const recentClose = close.slice(-20);
  const recentHigh = high.slice(-20);
  const recentLow = low.slice(-20);

  // 1. 价格波动范围检测
  const maxPrice = Math.max(...recentHigh);
  const minPrice = Math.min(...recentLow);
  const priceRange = maxPrice - minPrice;
  const avgClose = recentClose.reduce((a, b) => a + b, 0) / recentClose.length;
  const rangeRatio = priceRange / avgClose;

  // 2. ATR波动率检测（增强过滤）
  let atrSum = 0;
  for (let i = 1; i < recentClose.length; i++) {
    const tr = Math.max(
      recentHigh[i] - recentLow[i],
      Math.abs(recentHigh[i] - recentClose[i-1]),
      Math.abs(recentLow[i] - recentClose[i-1])
    );
    atrSum += tr;
  }
  const atr = atrSum / 19; // 20根K线计算19个TR值
  const atrPercent = atr / avgClose;

  // 3. 方向变化频率检测（新增）
  let directionChanges = 0;
  for (let i = 2; i < recentClose.length; i++) {
    const prevTrend = recentClose[i-1] - recentClose[i-2];
    const currTrend = recentClose[i] - recentClose[i-1];
    if (Math.sign(prevTrend) !== Math.sign(currTrend)) directionChanges++;
  }

  // 综合判断（满足任一条件即视为横盘）
  return (
    rangeRatio < priceRangeRatio ||      // 价格波动范围过小
    atrPercent < atrThreshold ||        // 波动率过低
    directionChanges >= 10              // 20根K线中超过10次方向变化
  );
}

function dynamicPriceRangeRatio(currentPrice, atr14, baseRatio) {
  // const baseRatio = 0.003; // 基础阈值
  const atrRatio = atr14 / currentPrice;
  return baseRatio * (1 + atrRatio); // 波动大的品种放宽阈值
}

function calculateADX(klines, period = 14) {
  if (!klines || klines.length < period * 2) return 0;

  const highs = klines.map(k => Number(k.high));
  const lows = klines.map(k => Number(k.low));
  const closes = klines.map(k => Number(k.close));
  
  // 计算真实波幅(TR)
  const tr = [Math.abs(highs[0] - lows[0])];
  for (let i = 1; i < klines.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  // 计算方向运动
  const upMoves = [0];
  const downMoves = [0];
  for (let i = 1; i < klines.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    upMoves.push(upMove > downMove && upMove > 0 ? upMove : 0);
    downMoves.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // 平滑计算
  const smoothTR = [tr.slice(0, period).reduce((a, b) => a + b, 0) / period];
  const smoothPlusDM = [upMoves.slice(0, period).reduce((a, b) => a + b, 0) / period];
  const smoothMinusDM = [downMoves.slice(0, period).reduce((a, b) => a + b, 0) / period];

  for (let i = period; i < klines.length; i++) {
    smoothTR.push(smoothTR[smoothTR.length - 1] - (smoothTR[smoothTR.length - 1] / period) + tr[i]);
    smoothPlusDM.push(smoothPlusDM[smoothPlusDM.length - 1] - (smoothPlusDM[smoothPlusDM.length - 1] / period) + upMoves[i]);
    smoothMinusDM.push(smoothMinusDM[smoothMinusDM.length - 1] - (smoothMinusDM[smoothMinusDM.length - 1] / period) + downMoves[i]);
  }

  // 计算方向指标(DI)
  const plusDI = [];
  const minusDI = [];
  const dx = [];
  for (let i = 0; i < smoothTR.length; i++) {
    plusDI.push(100 * (smoothPlusDM[i] / smoothTR[i]));
    minusDI.push(100 * (smoothMinusDM[i] / smoothTR[i]));
    
    const diDiff = Math.abs(plusDI[i] - minusDI[i]);
    const diSum = plusDI[i] + minusDI[i];
    dx.push(100 * (diDiff / (diSum !== 0 ? diSum : 1)));
  }

  // 计算ADX
  const adx = [dx.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < dx.length; i++) {
    adx.push((adx[adx.length - 1] * (period - 1) + dx[i]) / period);
  }

  return adx[adx.length - 1]; // 返回最新ADX值
}

module.exports = {
  isFlatMarket,
  dynamicPriceRangeRatio,
  calculateADX
};