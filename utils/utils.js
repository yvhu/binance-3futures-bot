// ============= 当前最新拆分公共函数 ============

function isInTradingTimeRange(timeRanges) {
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTime = currentHours * 100 + currentMinutes; // 转换为数字便于比较 如0930

  return timeRanges.some(range => {
    const [startHour, startMinute] = range.start.split(':').map(Number);
    const [endHour, endMinute] = range.end.split(':').map(Number);

    const startTime = startHour * 100 + startMinute;
    const endTime = endHour * 100 + endMinute;

    return currentTime >= startTime && currentTime <= endTime;
  });
}
// ============= 配合动态止盈止损 ==============

async function fetchKlines(symbol, interval, limit = 2) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    openTime: k[0],
    open: k[1], // 保持字符串形式
    high: k[2], // 保持字符串形式
    low: k[3],  // 保持字符串形式
    close: k[4], // 保持字符串形式
    volume: k[5] // 保持字符串形式
  }));
}

async function calculateATR(symbol, period) {
  const klines = await fetchKlines(symbol, '15m', period + 1);
  
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i-1][4]);
    trSum += Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }
  return trSum / period;
}

async function calculateSupportResistance(symbol) {
  const klines = await fetchKlines(symbol, '15m', 50); // 50根K线数据
  
  const prices = klines.flatMap(k => [
    parseFloat(k[2]), // high
    parseFloat(k[3]), // low
    parseFloat(k[4])  // close
  ]).sort((a,b) => a - b);

  // 识别关键价位（简化版）
  return {
    support: findClusterLevel(prices, 'lower'),  // 下方价格聚集区
    resistance: findClusterLevel(prices, 'upper') // 上方价格聚集区
  };
}

// 寻找价格聚集区
function findClusterLevel(prices, type) {
  const threshold = 0.005; // 0.5%价格区间
  let bestLevel = type === 'upper' ? Math.max(...prices) : Math.min(...prices);
  let maxCount = 0;

  for (const price of prices) {
    const count = prices.filter(p => 
      type === 'upper' 
        ? p >= price && p <= price * (1 + threshold)
        : p <= price && p >= price * (1 - threshold)
    ).length;

    if (count > maxCount) {
      maxCount = count;
      bestLevel = price;
    }
  }
  return bestLevel;
}

module.exports = {
  isInTradingTimeRange,
  calculateATR,
  calculateSupportResistance,
  fetchKlines,
};