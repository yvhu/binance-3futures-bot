// utils/position.js
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const crypto = require('crypto');
const config = require('../config/config');
const { EMA, BollingerBands } = require('technicalindicators');

const POSITION_FILE = path.resolve(__dirname, '../cache/position.json');
const BINANCE_API = config.binance.baseUrl || 'https://fapi.binance.com';

// 获取指定币种的 K 线数据（默认获取 50 根）
async function fetchKlines(symbol, interval, limit = 50) {
  const url = `${config.binance.baseUrl}${config.binance.endpoints.klines}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await proxyGet(url);

  return response.data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

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

/**
 * 从币安合约账户获取所有持仓并写入本地缓存
 */
async function refreshPositionsFromBinance() {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', config.binance.apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${BINANCE_API}/fapi/v2/positionRisk?${queryString}&signature=${signature}`;
  const headers = { 'X-MBX-APIKEY': config.binance.apiKey };

  try {
    const res = await proxyGet(url, { headers });
    const allPositions = res.data;

    // 清空旧数据
    writeAllPositions({});

    for (const pos of allPositions) {
      const symbol = pos.symbol;
      const amt = parseFloat(pos.positionAmt);
      if (amt === 0) continue; // 忽略空仓

      const side = amt > 0 ? 'BUY' : 'SELL';
      const time = Date.now();
      const positionAmt = amt;
      const entryPrice = parseFloat(pos.entryPrice);

      // === 新增：获取当前K线，用于计算 entryEMA 和 entryBOLL ===
      const interval = '3m';
      const klines = (await fetchKlines(symbol, interval, 51)).slice(0, -1);
      if (!klines || klines.length < 30) continue;

      const closePrices = klines.map(k => k.close);

      const ema21 = EMA.calculate({ period: 21, values: closePrices });
      const boll = BollingerBands.calculate({ period: 20, values: closePrices });

      if (ema21.length === 0 || boll.length === 0) continue;

      const entryEMA = ema21[ema21.length - 1];
      const entryBOLL = boll[boll.length - 1].middle;
      // === 写入本地持仓缓存，包括 entryEMA/BOLL 中轨 ===
      setPosition(symbol, {
        time,
        side,
        positionAmt,
        entryPrice,
        entryEMA,
        entryBOLL
      });
    }
    log(`✅ 已从币安刷新持仓，共 ${allPositions.filter(p => parseFloat(p.positionAmt) !== 0).length} 个币种`);
  } catch (err) {
    log(`❌ 获取持仓失败：${err.response?.data?.msg || err.message}`);
  }
}

module.exports = {
  getPosition,
  setPosition,
  removePosition,
  readAllPositions,
  hasPosition,
  refreshPositionsFromBinance
};
