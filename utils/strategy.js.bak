// utils/strategy.js
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const STRATEGY_FILE = path.resolve(__dirname, '../cache/strategy.json');

// 确保文件存在
function ensureStrategyFile() {
  if (!fs.existsSync(STRATEGY_FILE)) {
    fs.writeFileSync(STRATEGY_FILE, JSON.stringify({
      type: 'ema_boll',      // 当前策略类型，如 'ema_boll'、'macd_rsi'
      autoSwitch: false,     // 是否允许自动切换策略
      lastRunTime: null,     // 上一次策略运行时间戳
      extraParams: {}        // 附加参数
    }, null, 2));
  }
}

// 读取策略数据
function readStrategy() {
  ensureStrategyFile();
  const raw = fs.readFileSync(STRATEGY_FILE);
  return JSON.parse(raw);
}

// 写入策略数据
function writeStrategy(data) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
  log(`📄 写入策略缓存：strategy.json`);
}

// 设置策略类型
function setStrategyType(type) {
  const data = readStrategy();
  data.type = type;
  writeStrategy(data);
}

// 设置附加参数（如参数配置、周期等）
function setExtraParams(params) {
  const data = readStrategy();
  data.extraParams = { ...data.extraParams, ...params };
  writeStrategy(data);
}

// 获取策略类型
function getStrategyType() {
  const data = readStrategy();
  return data.type;
}

// 设置是否允许自动切换策略
function setAutoSwitch(enabled) {
  const data = readStrategy();
  data.autoSwitch = !!enabled;
  writeStrategy(data);
}

function getAllStrategies() {
  return [
    { id: 'ema_boll', name: '📈 EMA+BOLL 策略' },
    { id: 'macd_rsi', name: '📉 MACD+RSI 策略' },
    { id: 'custom', name: '🧪 自定义策略' }
  ];
}


module.exports = {
  readStrategy,
  writeStrategy,
  getStrategyType,
  setStrategyType,
  setExtraParams,
  setAutoSwitch,
  getAllStrategies
};
