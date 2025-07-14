const { readAllPositions, removePosition } = require('../utils/position');
const { EMA, BollingerBands } = require('technicalindicators');
const { placeOrder } = require('../binance/trade'); // 实盘卖出函数
const { sendTelegramMessage } = require('../telegram/messenger');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');

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


/**
 * 遍历本地所有持仓，判断是否触发止盈或止损，并自动执行平仓操作
 * - 若当前收益为负，则强制止损
 * - 若当前收益为正，则判断是否跌破 EMA21，或前一K线在 BOLL 中轨下方，满足条件保留，否则止盈
 */
async function checkAndCloseLosingPositions() {
  const allPositions = readAllPositions(); // 从本地缓存读取所有持仓记录

  for (const symbol in allPositions) {
    try {
      const pos = allPositions[symbol]; // 单个币种持仓记录 { entryPrice, side, positionAmt, time }

      // 获取该币种的 3 分钟周期的最近 100 根K线
      const klines = await fetchKlines(symbol, '3m', 100);
      if (!klines || klines.length < 30) continue; // 若数据不足则跳过

      // 提取收盘价序列
      const closePrices = klines.map(k => k.close);

      // 计算 EMA21 和 BollingerBands(20)
      const ema21 = EMA.calculate({ period: 21, values: closePrices });
      const boll = BollingerBands.calculate({ period: 20, values: closePrices });

      // 确保指标数据足够用于判断
      if (ema21.length < 2 || boll.length < 2) continue;

      // 获取前一根 K线的收盘价
      const lastKline = klines[klines.length - 2];
      const prevClose = lastKline.close;

      // 获取前一根 EMA 和 BOLL 中轨数据
      const prevEMA = ema21[ema21.length - 2];
      const prevBOLL = boll[boll.length - 2];

      // 获取持仓基础信息
      const entryPrice = pos.entryPrice;
      const positionAmt = pos.positionAmt;
      const isLong = pos.side === 'BUY'; // 做多为 BUY，做空为 SELL

      // 当前价格用最新一根 K线收盘价
      const currentPrice = closePrices[closePrices.length - 1];

      // 计算收益率（正为盈利，负为亏损）
      const pnlRate = isLong
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;

      log(`${symbol} 当前收益率：${(pnlRate * 100).toFixed(2)}%`);

      let shouldClose = false; // 是否应平仓

      // 若当前持仓处于亏损状态 → 直接止损
      if (pnlRate < 0) {
        shouldClose = true;
        log(`🔻 ${symbol} 亏损止损触发`);
      } else {
        // 若盈利，则判断是否破位
        const bollMiddle = prevBOLL.middle;
        // 条件：前一K线收盘价 < EMA21 或 < BOLL中轨，才认为趋势完好可继续持有
        if (prevClose < prevEMA || prevClose < bollMiddle) {
          log(`🔸 ${symbol} 盈利但破位，触发止盈`);
          shouldClose = false;
        } else {
          shouldClose = false;
          log(`✅ ${symbol} 盈利状态良好，继续持有`);
        }
      }

      // 执行平仓操作
      if (shouldClose) {
        const side = isLong ? 'SELL' : 'BUY'; // 平掉原方向
        await placeOrder(symbol, side, positionAmt); // 发起市价单平仓
        sendTelegramMessage(`📤 ${symbol} 仓位已平仓，原因：${pnlRate < 0 ? '止损' : '止盈破位'}`);
        removePosition(symbol); // 删除本地缓存中的持仓
      }

    } catch (err) {
      log(`❌ 检查持仓 ${symbol} 时失败：${err.message}`);
    }
  }
}

module.exports = { checkAndCloseLosingPositions };