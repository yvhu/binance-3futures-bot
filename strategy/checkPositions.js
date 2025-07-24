const { readAllPositions, removePosition } = require('../utils/position');
const { EMA, BollingerBands } = require('technicalindicators');
const { placeOrder } = require('../binance/trade'); // 实盘卖出函数
const { sendTelegramMessage } = require('../telegram/messenger');
const config = require('../config/config');
const { log } = require('../utils/logger');
const { proxyGet, proxyPost, proxyDelete } = require('../utils/request');
const { isSideways } = require('../utils/sideways');

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
// 异步函数：检查本地缓存的所有持仓，并根据条件判断是否需要平仓
async function checkAndCloseLosingPositions() {
  // 从本地缓存中读取所有当前持仓数据，例如：{ BTCUSDT: { entryPrice, side, positionAmt, time }, ... }
  const allPositions = readAllPositions();

  // 遍历每一个持仓币种
  for (const symbol in allPositions) {
    try {
      // 获取当前币种的持仓信息
      const pos = allPositions[symbol]; // 包含：进场价格、方向（BUY/SELL）、持仓数量、持仓时间

      const interval = config.interval || '3m'; // 使用3分钟K线
      const limit = 100;     // 请求K线数量

      // 获取币种K线数据，并剔除最后一根未收盘的K线（slice 0 到 -1）
      const klines = (await fetchKlines(symbol, interval, limit + 1)).slice(0, -1);
      // const klines = await fetchKlines(symbol, interval, 100); // 拉取足够的历史K线
      if (!klines || klines.length < 30) continue; // 数据不足则跳过

      // 提取收盘价数组
      const closePrices = klines.map(k => k.close);

      // 计算21周期的EMA（用于趋势判断）
      const ema21 = EMA.calculate({ period: 21, values: closePrices });

      // 计算20周期的布林带指标（返回上轨/中轨/下轨）
      const boll = BollingerBands.calculate({ period: 20, values: closePrices });

      // 若指标数组不足两个点（正常应等于K线数量 - period），跳过该币种
      if (ema21.length < 2 || boll.length < 2) continue;

      // 取倒数第一根K线（已收盘）用于判断信号
      const lastKline = klines[klines.length - 1];

      // 获取该K线的收盘价
      const prevClose = lastKline.close;

      // 获取对应位置的 EMA21 和布林中轨值
      const prevEMA = ema21[ema21.length - 1];
      const prevBOLL = boll[boll.length - 1];
      const bollMiddle = prevBOLL.middle;

      // 提取持仓数据：进场价、持仓数量、进场时间戳、方向
      const entryPrice = pos.entryPrice;
      const positionAmt = pos.positionAmt;
      const entryTime = pos.time;
      const isLong = pos.side === 'BUY'; // 判断是否为多单

      // 获取最新一根收盘K线的收盘价作为当前价（用于计算收益率）
      const currentPrice = closePrices[closePrices.length - 1];

      // 计算当前收益率（多单为当前-进场/进场，空单相反）
      const pnlRate = isLong
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;

      // 打印当前收益率
      log(`${symbol} 当前收益率：${(pnlRate * 100 * 10).toFixed(2)}%`);

      // 是否需要平仓的标志位及理由
      let shouldClose = false;
      let reason = '';

      // === 条件①：当前是亏损状态，触发止损 ===
      log(`🔻 ${symbol} 条件①：当前是亏损状态，触发止损 pnlRate: ${pnlRate}`);
      if (pnlRate < 0) {
        shouldClose = true;
        reason = '止损';
        log(`🔻 ${symbol} 亏损止损触发`);
      }

      // === 条件②：虽然是盈利状态，但价格跌破EMA21或布林中轨，视为趋势破位，触发止盈 ===
      else if (
        pnlRate > 0 &&   // ① 当前持仓是盈利状态（如果是亏损，不能触发止盈）
        (
          (pos.entryPrice > pos.entryEMA && prevClose < prevEMA) ||   // ②A. 入场时高于EMA21，现价跌破EMA21
          (pos.entryPrice > pos.entryBOLL && prevClose < bollMiddle)  // ②B. 入场时高于BOLL中轨，现价跌破中轨
        )
      ) {
        shouldClose = true;
        reason = '止盈破位';
        log(`🔸 ${symbol} 盈利但破位，触发止盈`);
      }

      // 在条件③：横盘判断处替换为：
      else if (config.sidewaysExit?.enable && pnlRate > 0) {
        log(`🔻 ${symbol} 打印横盘判断条件 closePrices：${closePrices} boll：${boll}`);
        const { sideways, reason: sidewaysReason } = isSideways(closePrices, boll, config.sidewaysExit);
        log(`🔻 ${symbol} 打印横盘判断结果 sideways：${sideways} sidewaysReason：${sidewaysReason}`);
        if (sideways) {
          shouldClose = true;
          reason = sidewaysReason;
          log(`🔹 ${symbol} ${sidewaysReason}`);
        }
      }

      // === 条件④：波动率持续收敛，认为行情熄火，止盈退出 ===
      else if (pnlRate > 0) {
        log(`🔻 ${symbol} 条件④：波动率持续收敛，认为行情熄火，止盈退出`);
        const lastN = 5;
        const bodies = klines.slice(-lastN).map(k => Math.abs(k.close - k.open));
        const avgBodySize = bodies.reduce((a, b) => a + b, 0) / lastN;
        const avgClosePrice = closePrices.slice(-lastN).reduce((a, b) => a + b, 0) / lastN;
        const bodyRatio = avgBodySize / avgClosePrice;

        const volatilityThreshold = config.volatilityExitThreshold || 0.0015; // 支持配置
        if (bodyRatio < volatilityThreshold) {
          shouldClose = true;
          reason = '波动率过低，趋势可能结束';
          log(`🔹 ${symbol} 收盘波动率压缩 (${(bodyRatio * 100).toFixed(3)}%)，触发止盈`);
        }
      }

      // === 条件⑤：持仓时间超过6分钟，且盈利不超过1%，被认为持仓效率差，触发平仓 ===
      else {
        const now = Date.now(); // 当前时间戳
        const heldMinutes = (now - entryTime) / 60000; // 持仓持续的分钟数
        // 大于6分钟 盈利低于5% 平仓
        log(`${symbol} 当前持仓时间：${heldMinutes}， 当前收益率：${pnlRate}, 配置率：${config.minProfitRate}`);
        if (heldMinutes > config.minHoldingMinutes && pnlRate < config.minProfitRate) {
          shouldClose = true;
          reason = `持仓${heldMinutes.toFixed(1)}分钟，收益不足5%`;
          log(`⚠️ ${symbol} 超时无明显盈利，触发平仓 当前收益率：${pnlRate}`);
        } else {
          // 不满足平仓条件，继续持有
          log(`✅ ${symbol} 盈利状态良好，继续持有`);
        }
        // 时间大于15分钟 盈亏比例小于10平仓
        if (heldMinutes > 15 && pnlRate < 0.01) {
          shouldClose = true;
          reason = `持仓${heldMinutes.toFixed(1)}分钟，收益不足10%`;
          log(`⚠️ ${symbol} 超时无明显盈利，触发平仓 当前收益率：${pnlRate}`);
        } else {
          // 不满足平仓条件，继续持有
          log(`✅ ${symbol} 盈利状态良好，继续持有`);
        }
      }

      // === 执行平仓动作 ===
      if (shouldClose) {
        const side = isLong ? 'SELL' : 'BUY'; // 平仓方向为原方向的反向
        await placeOrder(symbol, side, positionAmt); // 发送市价单平仓
        sendTelegramMessage(`📤 ${symbol} 仓位已平仓，原因：${reason}`); // 通知Telegram
        removePosition(symbol); // 从本地缓存中移除该币种持仓记录
      }

    } catch (err) {
      // 捕获该币种处理过程中的异常，记录错误信息
      log(`❌ 检查持仓 ${symbol} 时失败：${err.message}`);
    }
  }
}


module.exports = { checkAndCloseLosingPositions };