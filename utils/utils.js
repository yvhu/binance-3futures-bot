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

async function fetchKLines(symbol, interval, limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    openTime: k[0],                    // 开盘时间
    open: parseFloat(k[1]),            // 开盘价
    high: parseFloat(k[2]),            // 最高价
    low: parseFloat(k[3]),             // 最低价
    close: parseFloat(k[4]),           // 收盘价
    volume: parseFloat(k[5]),          // 成交量
    closeTime: k[6],                   // 收盘时间
    quoteVolume: parseFloat(k[7]),     // 成交额
    trades: k[8],                      // 成交笔数
    takerBuyBaseVolume: parseFloat(k[9]),  // 主动买入成交量
    takerBuyQuoteVolume: parseFloat(k[10]), // 主动买入成交额
    ignore: parseFloat(k[11])          // 忽略字段
  }));
}

async function calculateATR(symbol, period) {
  const klinesRaw = await fetchKLines(symbol, '15m', period + 2);
  const klines = klinesRaw.slice(0, -1);


  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i - 1][4]);
    trSum += Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
  }
  return trSum / period;
}

async function calculateSupportResistance(symbol) {
  const klinesRaw = await fetchKLines(symbol, '15m', 50);
  const klines = klinesRaw.slice(0, -1);

  const prices = klines.flatMap(k => [
    parseFloat(k[2]), // high
    parseFloat(k[3]), // low
    parseFloat(k[4])  // close
  ]).sort((a, b) => a - b);

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

// 新增趋势强度计算函数（0-1范围）
function calculateTrendStrength(klines) {
  const closes = klines.map(k => parseFloat(k.close));
  const smaShort = simpleMA(closes, 5);  // 5周期均线
  const smaLong = simpleMA(closes, 20);  // 20周期均线

  // 标准化趋势强度（0-1）
  const rawStrength = (smaShort - smaLong) / (smaLong * 0.05);
  return Math.min(1, Math.max(0, rawStrength));
}

// 简单移动平均计算
function simpleMA(data, period) {
  if (period <= 0 || data.length < period) return NaN;

  let sum = 0;
  // 使用经典for循环提升性能
  for (let i = data.length - period; i < data.length; i++) {
    sum += data[i];
  }
  return sum / period;
}

// 趋势文本转换函数
function getTrendText(trend) {
  const trendMap = {
    'bullish': '上涨',
    'bearish': '下跌',
    'strong_bullish': '强烈上涨',
    'strong_bearish': '强烈下跌',
    'neutral': '震荡',
    'error': '错误'
  };
  return trendMap[trend] || trend;
}

// 交易建议函数
function getTradingSuggestion(marketAnalysis) {
  if (!marketAnalysis.isOneSided) {
    return "市场震荡，建议观望或短线操作";
  }

  switch (marketAnalysis.trend) {
    case 'strong_bullish':
      return "强烈单边上涨，可考虑顺势做多";
    case 'bullish':
      return "单边上涨行情，适合多头策略";
    case 'strong_bearish':
      return "强烈单边下跌，可考虑顺势做空";
    case 'bearish':
      return "单边下跌行情，适合空头策略";
    default:
      return "市场状态不明，建议谨慎操作";
  }
}

module.exports = {
  isInTradingTimeRange,
  calculateATR,
  calculateSupportResistance,
  fetchKLines,
  calculateTrendStrength,
  simpleMA,
  getTrendText,
  getTradingSuggestion,
};