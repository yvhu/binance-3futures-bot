const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { log } = require('./logger');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
// 初始化缓存目录
const ensureCacheDir = () => {
  const dir = path.resolve('./cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
};

// 缓存Top50 + 精度信息
const cacheTopSymbols = async () => {
  ensureCacheDir();
  
  // 1. 获取合约市场信息（确定哪些是永续合约）
  const exchangeInfoUrl = config.binance.baseUrl + config.binance.endpoints.exchangeInfo;
  const infoRes = await proxyGet(exchangeInfoUrl);
  
  // 提取所有USDT永续合约的symbol
  const perpetualSymbols = infoRes.data.symbols
    .filter(s => 
      s.contractType === 'PERPETUAL' && // 永续合约
      s.quoteAsset === 'USDT' &&       // USDT保证金
      s.status === 'TRADING'           // 正在交易中
    )
    .map(s => s.symbol);

  // 2. 获取24小时成交量数据
  const tickerUrl = config.binance.baseUrl + config.binance.endpoints.ticker24hr;
  const tickerRes = await proxyGet(tickerUrl);

  // 3. 过滤永续合约 + 按成交量排序
  const sorted = tickerRes.data
    .filter(item => 
      perpetualSymbols.includes(item.symbol) && // 只保留永续合约
      !item.symbol.includes('_')               // 排除带有_的合约（如BTCUSDT_2406）
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  // log(`✅ 全部永续合约数据：${JSON.stringify(sorted.map(item => item.symbol), null, 2)}`);
  
  // 4. 取前50名
  const top50 = sorted.slice(0, 50).map(i => i.symbol);
  fs.writeFileSync(config.cachePaths.top50, JSON.stringify(top50, null, 2));
  // log(`✅ 缓存 Top50 USDT永续合约：${top50.length} 个`);

  // 5. 缓存精度信息（保持不变）
  const symbolPrecisions = {};
  top50.forEach(symbol => {
    const info = infoRes.data.symbols.find(s => s.symbol === symbol);
    if (info) {
      const priceFilter = info.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotSizeFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');
      const notionalFilter = info.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      symbolPrecisions[symbol] = {
        pricePrecision: getDecimalPlaces(priceFilter.tickSize),
        quantityPrecision: getDecimalPlaces(lotSizeFilter.stepSize),
        minQty: parseFloat(lotSizeFilter.minQty),     // ✅ 最小下单数量
        minNotional: parseFloat(notionalFilter?.notional || 5) // 可选：最小名义金额
      };

    }
  });

  fs.writeFileSync(config.cachePaths.precision, JSON.stringify(symbolPrecisions, null, 2));
  // log(`📌 缓存精度信息：${Object.keys(symbolPrecisions).length} 个币种`);
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

// 添加币种到 top50 缓存 addToTopSymbols('WIFUSDT');

function addToTopSymbols(symbol) {
  const filePath = config.cachePaths.top50;
  let topSymbols = [];

  if (fs.existsSync(filePath)) {
    topSymbols = JSON.parse(fs.readFileSync(filePath));
  }

  if (!topSymbols.includes(symbol)) {
    topSymbols.push(symbol);
    fs.writeFileSync(filePath, JSON.stringify(topSymbols, null, 2));
    log(`✅ 已添加 ${symbol} 到 topSymbols`);
  } else {
    log(`ℹ️ ${symbol} 已存在于 topSymbols`);
  }
}

// 从 top50 缓存中移除币种 removeFromTopSymbols('DOGEUSDT');
function removeFromTopSymbols(symbol) {
  const filePath = config.cachePaths.top50;
  if (!fs.existsSync(filePath)) return;

  let topSymbols = JSON.parse(fs.readFileSync(filePath));
  const updated = topSymbols.filter(s => s !== symbol);

  if (updated.length !== topSymbols.length) {
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    log(`🗑️ 已移除 ${symbol} 从 topSymbols`);
  } else {
    log(`⚠️ ${symbol} 不存在于 topSymbols`);
  }
}

// 获取某币种的精度信息
const getSymbolPrecision = (symbol) => {
  console.log('缓存文件路径:', config.cachePaths.precision); // 调试输出路径
  if (!fs.existsSync(config.cachePaths.precision)) {
    console.error('❌ 缓存文件不存在:', config.cachePaths.precision);
    return null;
  }
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

// 清空已选币种缓存文件内容
const clearSelectedSymbol = () => {
  if (fs.existsSync(config.cachePaths.selectedSymbol)) {
    fs.writeFileSync(config.cachePaths.selectedSymbol, JSON.stringify({}, null, 2));
    log('🧹 已清空已选币种缓存文件内容');
  } else {
    log('ℹ️ 已选币种缓存文件不存在，无需清空');
  }
};

// 缓存 仓位比例
function cachePositionRatio(ratio) {
  const filePath = path.resolve(config.cachePaths.patio || './cache/ratio.json');
  fs.writeFileSync(filePath, JSON.stringify({ ratio }), 'utf-8');
}

// 获取仓位比例
function getCachedPositionRatio() {
  const filePath = path.resolve(config.cachePaths.patio || './cache/ratio.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.ratio;
  } catch (e) {
    return null;
  }
}

module.exports = {
  cacheTopSymbols,
  getCachedTopSymbols,
  cacheSelectedSymbol,
  getSelectedSymbol,
  getSymbolPrecision,
  clearSelectedSymbol,
  cachePositionRatio,
  getCachedPositionRatio,
  addToTopSymbols,
  removeFromTopSymbols,
};
