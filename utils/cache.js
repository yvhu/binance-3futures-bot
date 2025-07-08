const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { log } = require('./logger');

// 初始化缓存目录
const ensureCacheDir = () => {
  const dir = path.resolve('./cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
};

const cacheTopSymbols = async () => {
  ensureCacheDir();
  const axios = require('axios');
  const url = config.binance.baseUrl + config.binance.endpoints.ticker24hr;
  const response = await axios.get(url);
  const sorted = response.data
    .filter(item => item.symbol.endsWith('USDT') && !item.symbol.includes('_'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  const top50 = sorted.slice(0, 50).map(i => i.symbol);
  fs.writeFileSync(config.cachePaths.top50, JSON.stringify(top50, null, 2));
  log(`✅ 缓存 Top50 币种：${top50.length} 个`);
};

const getCachedTopSymbols = () => {
  if (!fs.existsSync(config.cachePaths.top50)) return [];
  return JSON.parse(fs.readFileSync(config.cachePaths.top50));
};

const cacheSelectedSymbol = (symbol) => {
  fs.writeFileSync(config.cachePaths.selectedSymbol, JSON.stringify({ symbol, time: Date.now() }, null, 2));
  log(`📌 缓存已选币种: ${symbol}`);
};

const getSelectedSymbol = () => {
  if (!fs.existsSync(config.cachePaths.selectedSymbol)) return null;
  const { symbol } = JSON.parse(fs.readFileSync(config.cachePaths.selectedSymbol));
  return symbol || null;
};

module.exports = {
  cacheTopSymbols,
  getCachedTopSymbols,
  cacheSelectedSymbol,
  getSelectedSymbol
};
