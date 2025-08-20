// utils/cache.js
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(__dirname, '../cache/state.json');

// 保证缓存文件存在
function ensureCacheFile() {
  if (!fs.existsSync(CACHE_FILE)) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2));
  }
}

// 读取全部缓存
function readCache() {
  ensureCacheFile();
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
}

// 写入全部缓存
function writeCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

// 设置 orderMode（'ratio' 或 'amount'）
function setOrderMode(mode) {
  const cache = readCache();
  cache.orderMode = mode;
  writeCache(cache);
}

// 获取 orderMode，默认 'ratio'
function getOrderMode() {
  const cache = readCache();
  return cache.orderMode || 'ratio';
}

module.exports = {
  setOrderMode,
  getOrderMode,
};
