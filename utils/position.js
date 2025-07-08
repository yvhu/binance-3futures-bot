// utils/position.js
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const POSITION_FILE = path.resolve(__dirname, '../cache/position.json');

// 初始化文件
function ensurePositionFile() {
  if (!fs.existsSync(POSITION_FILE)) {
    fs.writeFileSync(POSITION_FILE, JSON.stringify({}, null, 2));
  }
}

// 读取所有持仓数据
function readAllPositions() {
  ensurePositionFile();
  const raw = fs.readFileSync(POSITION_FILE);
  return JSON.parse(raw);
}

// 写入所有持仓数据
function writeAllPositions(data) {
  fs.writeFileSync(POSITION_FILE, JSON.stringify(data, null, 2));
}

// 获取单个币种持仓
function getPosition(symbol) {
  const all = readAllPositions();
  return all[symbol] || null;
}

// 是否有该币种持仓
function hasPosition(symbol) {
  const all = readAllPositions();
  return !!all[symbol];
}

// 设置币种持仓记录
function setPosition(symbol, data) {
  const all = readAllPositions();
  all[symbol] = data;
  writeAllPositions(all);
  log(`💾 写入持仓缓存：${symbol}`);
}

// 删除持仓记录
function removePosition(symbol) {
  const all = readAllPositions();
  delete all[symbol];
  writeAllPositions(all);
  log(`🧹 删除持仓缓存：${symbol}`);
}

module.exports = {
  getPosition,
  setPosition,
  removePosition,
  hasPosition
};
