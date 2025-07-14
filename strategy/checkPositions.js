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
  const allPositions = readAllPositions(); // 读取本地缓存的持仓记录

  for (const symbol in allPositions) {
    try {
      const pos = allPositions[symbol]; // 持仓信息：{ entryPrice, side, positionAmt, time }

      const klines = await fetchKlines(symbol, '3m', 100);
      if (!klines || klines.length < 30) continue;

      const closePrices = klines.map(k => k.close);
      const ema21 = EMA.calculate({ period: 21, values: closePrices });
      const boll = BollingerBands.calculate({ period: 20, values: closePrices });
      if (ema21.length < 2 || boll.length < 2) continue;

      const lastKline = klines[klines.length - 2]; // 倒数第二根K线
      const prevClose = lastKline.close;
      const prevEMA = ema21[ema21.length - 2];
      const prevBOLL = boll[boll.length - 2];
      const bollMiddle = prevBOLL.middle;

      const entryPrice = pos.entryPrice;
      const positionAmt = pos.positionAmt;
      const entryTime = pos.time;
      const isLong = pos.side === 'BUY';

      const currentPrice = closePrices[closePrices.length - 1];

      const pnlRate = isLong
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;

      log(`${symbol} 当前收益率：${(pnlRate * 100).toFixed(2)}%`);

      let shouldClose = false;
      let reason = '';

      // === 条件①：亏损则止损 ===
      if (pnlRate < 0) {
        shouldClose = true;
        reason = '止损';
        log(`🔻 ${symbol} 亏损止损触发`);
      }

      // === 条件②：盈利但破位EMA21或中轨，止盈 ===
      else if (prevClose < prevEMA || prevClose < bollMiddle) {
        shouldClose = true;
        reason = '止盈破位';
        log(`🔸 ${symbol} 盈利但破位，触发止盈`);
      }

      // === 条件③：持仓超过6分钟 且 收益率不足1%，止盈效率不佳 ===
      else {
        const now = Date.now();
        const heldMinutes = (now - entryTime) / 60000;

        if (heldMinutes > 6 && pnlRate < 0.01) {
          shouldClose = true;
          reason = `持仓${heldMinutes.toFixed(1)}分钟，收益不足1%`;
          log(`⚠️ ${symbol} 超时无明显盈利，触发平仓`);
        } else {
          log(`✅ ${symbol} 盈利状态良好，继续持有`);
        }
      }

      // === 平仓动作 ===
      if (shouldClose) {
        const side = isLong ? 'SELL' : 'BUY'; // 平掉原方向
        await placeOrder(symbol, side, positionAmt); // 市价平仓
        sendTelegramMessage(`📤 ${symbol} 仓位已平仓，原因：${reason}`);
        removePosition(symbol);
      }

    } catch (err) {
      log(`❌ 检查持仓 ${symbol} 时失败：${err.message}`);
    }
  }
}

module.exports = { checkAndCloseLosingPositions };