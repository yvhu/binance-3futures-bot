// 非严格header接口

const config = require('../config/config');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';
// ✅ 获取24小时成交量（已集成 cache.js 中，不重复）
async function getTopSymbols() {
  const response = await proxyGet(`${BINANCE_API}${config.binance.endpoints.ticker24hr}`);
  return response.data;
}

// ✅ 获取 K 线数据（用于指标分析）
async function getKlines(symbol, interval = '3m', limit = 50) {
  const url = `${BINANCE_API}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);
  return response.data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

/**
 * 获取币种当前市场价格（USDT合约）
 * @param {string} symbol 交易对，如 BTCUSDT
 * @returns {number} 当前最新成交价
 */
async function getCurrentPrice(symbol) {
  const url = `${BINANCE_API}/fapi/v1/ticker/price?symbol=${symbol}`;
  const res = await proxyGet(url);
  return parseFloat(res.data.price);
}

module.exports = {
  getTopSymbols,
  getKlines,
  getCurrentPrice
};
