const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { log } = require('./logger');

// 初始化缓存目录
const ensureCacheDir = () => {
  const dir = path.resolve('./cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
};

// 缓存Top50 + 精度信息
const cacheTopSymbols = async () => {
  ensureCacheDir();
  const axios = require('axios');

  // 获取币种24小时成交量排序
  const tickerUrl = config.binance.baseUrl + config.binance.endpoints.ticker24hr;
  const tickerRes = await axios.get(tickerUrl);

  const sorted = tickerRes.data
    .filter(item => item.symbol.endsWith('USDT') && !item.symbol.includes('_'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  const top50 = sorted.slice(0, 50).map(i => i.symbol);
  fs.writeFileSync(config.cachePaths.top50, JSON.stringify(top50, null, 2));
  log(`✅ 缓存 Top50 币种：${top50.length} 个`);

  // 获取精度信息（来自 exchangeInfo）
  const exchangeInfoUrl = config.binance.baseUrl + '/fapi/v1/exchangeInfo';
  const infoRes = await axios.get(exchangeInfoUrl);
  const symbolPrecisions = {};

  top50.forEach(symbol => {
    const info = infoRes.data.symbols.find(s => s.symbol === symbol);
    if (info) {
      const priceFilter = info.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');

      symbolPrecisions[symbol] = {
        pricePrecision: getDecimalPlaces(priceFilter.tickSize),
        quantityPrecision: getDecimalPlaces(lotSizeFilter.stepSize)
      };
    }
  });

  fs.writeFileSync(config.cachePaths.precision, JSON.stringify(symbolPrecisions, null, 2));
  log(`📌 缓存精度信息：${Object.keys(symbolPrecisions).length} 个币种`);
};

// 从字符串型 tickSize/stepSize 中获取小数位数
function getDecimalPlaces(numStr) {
  const parts = numStr.split('.');
  if (parts.length === 2) {
    return parts[1].search(/[^0]/); // 第一个非零位置
  }
  return 0;
}

// 获取缓存的 Top50 币种列表
const getCachedTopSymbols = () => {
  if (!fs.existsSync(config.cachePaths.top50)) return [];
  return JSON.parse(fs.readFileSync(config.cachePaths.top50));
};

// 获取某币种的精度信息
const getSymbolPrecision = (symbol) => {
  if (!fs.existsSync(config.cachePaths.precision)) return null;
  const data = JSON.parse(fs.readFileSync(config.cachePaths.precision));
  return data[symbol] || null;
};

// 缓存手动选择的币种
const cacheSelectedSymbol = (symbol) => {
  fs.writeFileSync(config.cachePaths.selectedSymbol, JSON.stringify({ symbol, time: Date.now() }, null, 2));
  log(`📌 缓存已选币种: ${symbol}`);
};

// 读取选中的币种
const getSelectedSymbol = () => {
  if (!fs.existsSync(config.cachePaths.selectedSymbol)) return null;
  const { symbol } = JSON.parse(fs.readFileSync(config.cachePaths.selectedSymbol));
  return symbol || null;
};

module.exports = {
  cacheTopSymbols,
  getCachedTopSymbols,
  cacheSelectedSymbol,
  getSelectedSymbol,
  getSymbolPrecision
};
