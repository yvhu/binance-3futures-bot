const axios = require('axios');
const config = require('../config/config');

// ✅ 获取24小时成交量（已集成 cache.js 中，不重复）
async function getTopSymbols() {
  const response = await axios.get(`${config.binance.baseUrl}${config.binance.endpoints.ticker24hr}`);
  return response.data;
}

// ✅ 获取 K 线数据（用于指标分析）
async function getKlines(symbol, interval = '3m', limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await axios.get(url);
  return response.data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

module.exports = {
  getTopSymbols,
  getKlines
};
