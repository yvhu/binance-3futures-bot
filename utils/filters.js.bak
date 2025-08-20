// 是否连续出现 N 根阴线
function countRedCandles(klines, count) {
  return klines.slice(-count).every(k => k.close < k.open);
}
// 是否连续出现 N 根阳线
function countGreenCandles(klines, count) {
  return klines.slice(-count).every(k => k.close > k.open);
}

module.exports = {
  countRedCandles,
  countGreenCandles
};