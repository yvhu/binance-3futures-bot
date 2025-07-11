// VWAP计算函数模块：成交量加权平均价（用于趋势判断）

function getVWAP(close, high, low, volume) {
  const vwap = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < close.length; i++) {
    const h = high[i];
    const l = low[i];
    const c = close[i];
    const v = volume[i];

    if ([h, l, c, v].some(val => typeof val !== 'number' || isNaN(val))) {
      // 如果有任何无效数据，则跳过该点
      vwap.push(i > 0 ? vwap[i - 1] : 0); // 用前一个值补上
      continue;
    }

    const typicalPrice = (h + l + c) / 3;
    cumulativeTPV += typicalPrice * v;
    cumulativeVolume += v;

    const value = cumulativeVolume === 0 ? 0 : cumulativeTPV / cumulativeVolume;
    vwap.push(+value.toFixed(6)); // 保留6位小数
  }

  return vwap;
}

module.exports = { getVWAP };
