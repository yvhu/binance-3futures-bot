// utils/vwap.js
// VWAP计算函数模块：成交量加权平均价（用于趋势判断）

function getVWAP(close, high, low, volume) {
  const vwap = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < close.length; i++) {
    const typicalPrice = (high[i] + low[i] + close[i]) / 3;
    cumulativeTPV += typicalPrice * volume[i];
    cumulativeVolume += volume[i];
    vwap.push(cumulativeTPV / cumulativeVolume);
  }

  return vwap;
}

module.exports = { getVWAP };
