// 非严格header接口

const config = require('../config/config');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const { getSymbolPrecision } = require('../utils/cache');
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';
const { log } = require('../utils/logger');
const crypto = require('crypto');
// 获取24小时价格变化数据
async function getTopSymbols() {
  try {
    const tickerUrl = config.binance.baseUrl + config.binance.endpoints.ticker24hr;
    const tickerRes = await proxyGet(tickerUrl);
    return tickerRes.data;
  } catch (error) {
    console.error('获取24小时数据失败:', error.message);
    return [];
  }
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
    // throw new Error(`Failed to fetch kline data: ${error.message}`);
  }
}

/**
 * 获取币种当前市场价格（USDT合约）
 * @param {string} symbol 交易对，如 BTCUSDT
 * @returns {number} 当前最新成交价
 */
// async function getCurrentPrice(symbol) {
//   try {
//     const url = `${BINANCE_API}/fapi/v1/ticker/price?symbol=${symbol}`;
//     const res = await proxyGet(url);
//     return parseFloat(res.data.price);
//   } catch (error) {
//     console.error(`Failed to fetch klines for ${symbol}:`, error);
//     // throw new Error(`Failed to get price data: ${error.message}`);
//   }
// }

async function getCurrentPrice(symbol) {
  try {
    // 1. 创建查询参数（包含时间戳防止重放）
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      timestamp: Date.now()
    });

    // 2. 对参数进行签名
    const signature = signParams(params);
    params.append('signature', signature);

    // 3. 构造请求URL（使用Binance最新价格接口）
    const url = `${config.binance.baseUrl}/fapi/v1/ticker/price?${params}`;

    // 4. 发送认证请求
    const res = await proxyGet(url, {
      headers: {
        'X-MBX-APIKEY': config.binance.apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 5000 // 5秒超时
    });

    // 5. 验证响应数据
    if (!res.data || typeof res.data.price !== 'string') {
      throw new Error('Invalid price response format');
    }

    // 6. 返回解析后的价格（带精度校验）
    return adjustPrecision(symbol, parseFloat(res.data.price));

  } catch (error) {
    // 7. 错误处理（带重试机制）
    let errorMsg = error.message;
    if (error.response) {
      errorMsg += ` | 状态码: ${error.response.status}`;
      if (error.response.data) {
        errorMsg += ` | 返回: ${JSON.stringify(error.response.data)}`;
      }
    }
    log(`❌ 获取 ${symbol} 价格失败: ${errorMsg}`);
  }
}

// 辅助函数：参数签名（与fetchAllPositions共用）
function signParams(params) {
  const query = params.toString();
  return crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(query)
    .digest('hex');
}

// 辅助函数：价格精度调整
function adjustPrecision(symbol, price) {
  const precision = getSymbolPrecision(symbol);
  return parseFloat(price.toFixed(precision.pricePrecision));
}

module.exports = {
  getTopSymbols,
  getKlines,
  getCurrentPrice
};
