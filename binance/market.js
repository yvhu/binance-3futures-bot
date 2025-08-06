// 非严格header接口

const config = require('../config/config');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';
// ✅ 获取24小时成交量（已集成 cache.js 中，不重复）
async function getTopSymbols() {
  const response = await proxyGet(`${BINANCE_API}${config.binance.endpoints.ticker24hr}`);
  return response.data;
}

/**
 * 获取币安K线数据
 * @param {string} symbol 交易对符号 (如: BTCUSDT)
 * @param {string} [interval='3m'] K线间隔 (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M)
 * @param {number} [limit=50] 返回的数据条数
 * @returns {Promise<Array<{
 *   openTime: number,
 *   open: number,
 *   high: number,
 *   low: number,
 *   close: number,
 *   volume: number,
 *   closeTime: number,
 *   quoteVolume: number,
 *   trades: number,
 *   takerBuyBaseVolume: number,
 *   takerBuyQuoteVolume: number,
 *   ignore: number
 * }>>}
 * @throws {Error} 当请求失败时抛出错误
 */
async function getKlines(symbol, interval = '3m', limit = 50) {
  try {
    const url = `${BINANCE_API}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await proxyGet(url);

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('Invalid response data format');
    }

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

  } catch (error) {
    console.error(`Failed to fetch klines for ${symbol}:`, error);
    throw new Error(`Failed to fetch kline data: ${error.message}`);
  }
}

/**
 * 获取币种当前市场价格（USDT合约）
 * @param {string} symbol 交易对，如 BTCUSDT
 * @returns {number} 当前最新成交价
 */
async function getCurrentPrice(symbol) {
  try {
    const url = `${BINANCE_API}/fapi/v1/ticker/price?symbol=${symbol}`;
    const res = await proxyGet(url);
    return parseFloat(res.data.price);
  } catch (error) {
    console.error(`Failed to fetch klines for ${symbol}:`, error);
    throw new Error(`Failed to get price data: ${error.message}`);
  }
}

module.exports = {
  getTopSymbols,
  getKlines,
  getCurrentPrice
};
