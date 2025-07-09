// 是否连续出现 N 根阴线
function countRedCandles(klines, count) {
  return klines.slice(-count).every(k => k.close < k.open);
}
// 是否连续出现 N 根阳线
function countGreenCandles(klines, maxCount) {
  let count = 0;
  for (let i = klines.length - maxCount; i < klines.length; i++) {
    const k = klines[i];
    if (parseFloat(k.close) > parseFloat(k.open)) {
      count++;
    }
  }
  return count >= maxCount;
}

module.exports = {
  countRedCandles,
  countGreenCandles
};