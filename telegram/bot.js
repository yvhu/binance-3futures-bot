/**
 * Telegram Bot 主要功能模块
 * - 初始化 bot 实例
 * - 绑定按钮事件和回调
 * - 发送主菜单
 * - 处理指令逻辑
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const { log } = require('../utils/logger');

const { clearSelectedSymbol, cacheSelectedSymbol, cacheTopSymbols } = require('../utils/cache');
const { runStrategyCycle } = require('../strategy/runner');
const { getSelectedSymbol } = require('../utils/cache');
const { selectBestSymbols } = require('../strategy/selector');
const { placeOrder } = require('../binance/trade');
const { refreshPositionsFromBinance, getPosition } = require('../utils/position');

const { setBot } = require('./state');
const { sendTelegramMessage } = require('./messenger');
const { getStrategyType, getAllStrategies, setStrategyType } = require('../utils/strategy');
const { cachePositionRatio, getCachedPositionRatio, getCachedTopSymbols, removeFromTopSymbols } = require('../utils/cache');
const { setOrderMode, getOrderMode } = require('../utils/state');
const { getSignalMode, toggleSignalMode } = require('../utils/tg-settings')
const { getStatsByPage } = require('../db/hourlyStats');

const { HttpsProxyAgent } = require('https-proxy-agent');

let serviceStatus = {
  running: true
};

// 添加全局变量存储当前分页状态
const paginationState = {
  currentPage: 1,
  pageSize: 10
};

/**
 * 初始化 Telegram Bot，启动监听，绑定回调事件
 */
async function initTelegramBot() {
  let botOptions = { polling: true };

  if (config.telegram.useProxy && config.telegram.proxyUrl) {
    botOptions.request = {
      agent: new HttpsProxyAgent(config.proxyUrl)
    };
    log(`🌐 使用代理启动 Telegram Bot：${config.proxyUrl}`);
  }

  const bot = new TelegramBot(config.telegram.token, botOptions);
  setBot(bot); // 设置全局 bot 实例，供其他模块获取

  log('🤖 Telegram Bot 已启动');

  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    await handleCommand(data, chatId);
  });

  bot.onText(/\/button/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() === config.telegram.chatId.toString()) {
      await sendMainMenu();
    } else {
      log(`⚠️ 未授权用户尝试使用 /button：${chatId}`);
    }
  });

  await sendMainMenu();
}

/**
 * 发送主控制面板菜单按钮
 */
async function sendMainMenu() {
  const bot = require('./state').getBot();
  if (!bot) {
    log('⚠️ 发送主菜单失败，bot 未初始化');
    return;
  }

  const strategyType = getStrategyType();
  const strategyList = getAllStrategies();
  const orderMode = getOrderMode(); // 读取当前模式

  const buttons = strategyType !== 'ema_boll' ? [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新多空数据', callback_data: 'refresh_signal' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }, { text: '🧹 清空已选币种', callback_data: 'clear_selected' }]
  ] : [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }],
    [{ text: `⚙️ 切换信号模式（当前：${getSignalMode()}）`, callback_data: 'toggle_signal_mode' }, { text: '📊 查询小时统计', callback_data: 'show_stats' }],
    [{ text: '📊 24小时止损统计', callback_data: 'show_daily_stats' }, { text: '📊 24小时止盈止损统计', callback_data: 'show_daily_stats_other' }],
    [{ text: '⏰ 全历史时段统计', callback_data: 'show_all_hourly_stats' }, { text: '📊 24小时段盈利/亏损统计', callback_data: 'analyze_hourly_profit_ratios' }],
  ];

  const ratioButtons = [
    { text: '💰 使用25%', callback_data: 'ratio_0.25' },
    { text: '💰 使用50%', callback_data: 'ratio_0.5' },
    { text: '💰 使用75%', callback_data: 'ratio_0.75' },
    { text: '💰 使用100%', callback_data: 'ratio_1' }
  ];

  if (strategyType == 'ema_boll') {
    log(`⚠️ 策略类型是： ${strategyType}, 不填加 持仓数量按钮`);
  } else {
    buttons.push(ratioButtons);
  }

  if (strategyType == 'ema_boll') {
    const modeButtons = [
      { text: `📊 按比例下单 ${orderMode === 'ratio' ? '✅' : ''}`, callback_data: 'order_mode_ratio' },
      { text: `💵 固定金额下单 ${orderMode === 'amount' ? '✅' : ''}`, callback_data: 'order_mode_amount' }
    ];
    buttons.push(modeButtons);
    // ✅ 新增：展示策略币种列表按钮
    const symbolListButton = [
      { text: '📋 查看策略币种列表', callback_data: 'show_symbol_list' }
    ];
    buttons.push(symbolListButton);
  } else {
    log(`⚠️ 策略类型是： ${strategyType}, 不填加 持仓数量按钮`);
  }

  const strategyButtons = strategyList.map(s => {
    const isSelected = s.id === strategyType;
    return [{ text: `${isSelected ? '✅' : ''} 切换为 ${s.name}`, callback_data: `set_strategy_${s.id}` }];
  });
  buttons.push(...strategyButtons);

  if (strategyType == 'ema_boll') {
    log(`⚠️ 策略类型是： ${strategyType}, 不填加 币种多空方向按钮`);
  } else {
    try {
      const { longList, shortList } = await selectBestSymbols();
      if (longList.length > 0) {
        const longButtons = longList.map(item => [{ text: `做多 ${item.symbol}`, callback_data: `long_${item.symbol}` }]);
        buttons.push(...longButtons);
      }
      if (shortList.length > 0) {
        const shortButtons = shortList.map(item => [{ text: `做空 ${item.symbol}`, callback_data: `short_${item.symbol}` }]);
        buttons.push(...shortButtons);
      }
    } catch (err) {
      log('⚠️ 选币失败:', err.message);
    }
  }

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

/**
 * 新增发送统计分页消息的函数
 * @param {*} page 
 * @returns 
 */
async function sendStatsPage(page = 1) {
  const bot = require('./state').getBot();
  const { data, total, pages } = getStatsByPage(require('../db').db, page, paginationState.pageSize);

  if (data.length === 0) {
    return sendTelegramMessage('📊 暂无统计数据');
  }

  paginationState.currentPage = page;

  // 使用表格形式展示数据
  let message = `📊 小时统计详情 (第 ${page}/${pages} 页)\n`;
  message += '════════════════════════════\n';

  data.forEach(stat => {
    message += `🕒 [${new Date(stat.hour).toLocaleString()}]\n`;
    message += `├─ 总盈亏: ${formatNumber(stat.total_profit)} USDT\n`;
    message += `├─ 交易次数: ${stat.trade_count}\n`;
    message += `├─ 均盈亏: ${formatNumber(stat.avg_profit_per_trade)} USDT\n`;
    message += `├─ 收益率统计:\n`;
    message += `│  ├─ 平均: ${stat.avg_return_rate.toFixed(2)}%\n`;
    message += `│  ├─ 最高: ${stat.max_return_rate.toFixed(2)}%\n`;
    message += `│  └─ 最低: ${stat.min_return_rate.toFixed(2)}%\n`;
    message += `├─ 做多统计:\n`;
    message += `│  ├─ 盈利: ${formatNumber(stat.long_profit)} (${stat.long_win_count}次)\n`;
    message += `│  ├─ 亏损: ${formatNumber(stat.long_loss)} (${stat.long_loss_count}次)\n`;
    message += `│  └─ 胜率: ${stat.long_win_rate.toFixed(1)}%\n`;
    message += `└─ 做空统计:\n`;
    message += `   ├─ 盈利: ${formatNumber(stat.short_profit)} (${stat.short_win_count}次)\n`;
    message += `   ├─ 亏损: ${formatNumber(stat.short_loss)} (${stat.short_loss_count}次)\n`;
    message += `   └─ 胜率: ${stat.short_win_rate.toFixed(1)}%\n`;
    message += '════════════════════════════\n';
  });

  message += `📝 总计: ${total} 条记录`;

  // 数字格式化函数（处理负数显示）
  function formatNumber(num) {
    return num >= 0 ?
      num.toFixed(2) :
      `-${Math.abs(num).toFixed(2)}`;
  }

  // 分页按钮
  const pageButtons = [];
  if (page > 1) {
    pageButtons.push({ text: '◀ 上一页', callback_data: `stats_page_${page - 1}` });
  }
  if (page < pages) {
    pageButtons.push({ text: '下一页 ▶', callback_data: `stats_page_${page + 1}` });
  }

  await bot.sendMessage(config.telegram.chatId, message, {
    reply_markup: {
      inline_keyboard: [
        pageButtons,
        [
          { text: '📅 按日期筛选', callback_data: 'filter_stats_date' },
          { text: '🔙 返回主菜单', callback_data: 'back_to_main' }
        ]
      ],
      parse_mode: 'Markdown'
    }
  });
}

/**
 * 发送币种按钮
 */
async function sendSymbolFilterMenu() {
  const bot = require('./state').getBot();
  if (!bot) {
    log('⚠️ 发送主菜单失败，bot 未初始化');
    return;
  }

  const symbolArray = getCachedTopSymbols(); // 返回数组
  if (!Array.isArray(symbolArray) || symbolArray.length === 0) {
    await sendTelegramMessage('⚠️ 当前无可用的缓存币种');
    return;
  }

  const rows = [];

  for (let i = 0; i < symbolArray.length; i += 2) {
    const row = [];

    for (let j = 0; j < 2; j++) {
      const symbol = symbolArray[i + j];
      if (!symbol) continue;

      row.push({
        text: `🗑 ${symbol}`,
        callback_data: `delete_symbol_${symbol}`
      });
    }

    if (row.length) rows.push(row);
  }

  await bot.sendMessage(config.telegram.chatId, '🧹 当前策略币种（点击删除）', {
    reply_markup: { inline_keyboard: rows }
  });
}

// 添加新的函数来计算和显示24小时统计数据
/**
 * 发送24小时交易统计数据
 * 包含盈利、亏损、净盈亏、胜率和最大回撤等信息
 * 亏损计算采用5%止损限制规则
 */
async function sendDailyStats() {
  const bot = require('./state').getBot();
  const db = require('../db').db;

  // 计算24小时前的时间
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 获取24小时内平仓的交易记录
  const trades = db.prepare(`
        SELECT * FROM trades 
        WHERE exit_time >= ?
        AND status = 'closed'
        ORDER BY exit_time DESC
    `).all(twentyFourHoursAgo);

  if (trades.length === 0) {
    await sendTelegramMessage('📊 近24小时内没有已平仓的交易记录');
    return;
  }

  let totalProfit = 0;
  let totalLoss = 0;
  let profitCount = 0;
  let lossCount = 0;
  let maxDrawdownPct = 0; // 最大回撤百分比
  const maxAllowedLossPct = 0.5; // 10倍杠杆下的5%→0.5%本金

  trades.forEach(trade => {
    // 计算实际盈亏
    const actualProfit = trade.side === 'BUY'
      ? (trade.exit_price - trade.entry_price) * trade.quantity
      : (trade.entry_price - trade.exit_price) * trade.quantity;

    // 计算最大允许亏损金额（0.5%本金）
    const maxAllowedLossAmount = trade.entry_price * trade.quantity * maxAllowedLossPct / 100;

    let adjustedProfit;
    if (trade.side === 'BUY') {
      // 做多：计算最大潜在亏损（开仓价到最低价）
      const maxPotentialLoss = (trade.entry_price - trade.kline_low) * trade.quantity;
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
    } else {
      // 做空：计算最大潜在亏损（最高价到开仓价）
      const maxPotentialLoss = (trade.kline_high - trade.entry_price) * trade.quantity;
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
    }

    // 统计分类
    if (adjustedProfit > 0) {
      totalProfit += adjustedProfit;
      profitCount++;
    } else {
      totalLoss += Math.abs(adjustedProfit);
      lossCount++;

      // 计算实际回撤百分比
      const drawdownPct = (Math.abs(adjustedProfit) / (trade.entry_price * trade.quantity) * 100);
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
      }
    }
  });

  const winRate = trades.length > 0 ? (profitCount / trades.length * 100) : 0;
  const netProfit = totalProfit - totalLoss;

  const message = [
    '📈 24小时交易统计（10倍杠杆，最大亏损0.5%本金）',
    '══════════════════════════════',
    `💰 总盈利: ${totalProfit.toFixed(2)} USDT (${profitCount}笔)`,
    `📉 总亏损: ${totalLoss.toFixed(2)} USDT (${lossCount}笔)`,
    `📊 净盈亏: ${netProfit.toFixed(2)} USDT`,
    `🎯 胜率: ${winRate.toFixed(1)}%`,
    `⚠️ 最大回撤: ${maxDrawdownPct.toFixed(2)}%本金`,
    `📝 总交易数: ${trades.length}笔`,
    '══════════════════════════════',
    `📅 统计时间: ${now.toLocaleString()}`
  ].join('\n');

  await bot.sendMessage(config.telegram.chatId, message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 刷新数据', callback_data: 'show_daily_stats' }],
        [{ text: '🔙 返回主菜单', callback_data: 'back_to_main' }]
      ]
    }
  });
}

async function sendDailyStatsOther() {
  const bot = require('./state').getBot();
  const db = require('../db').db;

  // 计算24小时前的时间
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 获取24小时内平仓的交易记录
  const trades = db.prepare(`
        SELECT * FROM trades 
        WHERE exit_time >= ?
        AND status = 'closed'
        ORDER BY exit_time DESC
    `).all(twentyFourHoursAgo);

  if (trades.length === 0) {
    await sendTelegramMessage('📊 近24小时内没有已平仓的交易记录');
    return;
  }

  let totalProfit = 0;
  let totalLoss = 0;
  let profitCount = 0;
  let lossCount = 0;
  let maxDrawdownPct = 0; // 最大回撤百分比
  const maxAllowedLossPct = 0.5; // 10倍杠杆下的5%→0.5%本金
  const takeProfitPct = 1.0; // 10倍杠杆下的10%→1.0%本金

  trades.forEach(trade => {
    // 计算实际盈亏
    const actualProfit = trade.side === 'BUY'
      ? (trade.exit_price - trade.entry_price) * trade.quantity
      : (trade.entry_price - trade.exit_price) * trade.quantity;

    // 计算最大允许亏损金额（0.5%本金）
    const maxAllowedLossAmount = trade.entry_price * trade.quantity * maxAllowedLossPct / 100;
    // 计算最大允许盈利金额（10%本金）
    const maxAllowedProfitAmount = trade.entry_price * trade.quantity * takeProfitPct / 100;

    let adjustedProfit;
    if (trade.side === 'BUY') {
      // 做多：计算最大潜在亏损（开仓价到最低价）
      const maxPotentialLoss = (trade.entry_price - trade.kline_low) * trade.quantity;
      // 计算最大潜在盈利（最高价到开仓价）
      const maxPotentialProfit = (trade.kline_high - trade.entry_price) * trade.quantity;

      // 先检查止损
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
      // 再检查止盈
      adjustedProfit = maxPotentialProfit > maxAllowedProfitAmount
        ? maxAllowedProfitAmount
        : adjustedProfit;
    } else {
      // 做空：计算最大潜在亏损（最高价到开仓价）
      const maxPotentialLoss = (trade.kline_high - trade.entry_price) * trade.quantity;
      // 计算最大潜在盈利（开仓价到最低价）
      const maxPotentialProfit = (trade.entry_price - trade.kline_low) * trade.quantity;

      // 先检查止损
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
      // 再检查止盈
      adjustedProfit = maxPotentialProfit > maxAllowedProfitAmount
        ? maxAllowedProfitAmount
        : adjustedProfit;
    }

    // 统计分类
    if (adjustedProfit > 0) {
      totalProfit += adjustedProfit;
      profitCount++;
    } else {
      totalLoss += Math.abs(adjustedProfit);
      lossCount++;

      // 计算实际回撤百分比
      const drawdownPct = (Math.abs(adjustedProfit) / (trade.entry_price * trade.quantity) * 100);
      if (drawdownPct > maxDrawdownPct) {
        maxDrawdownPct = drawdownPct;
      }
    }
  });

  const winRate = trades.length > 0 ? (profitCount / trades.length * 100) : 0;
  const netProfit = totalProfit - totalLoss;

  const message = [
    '📈 24小时交易统计（10倍杠杆，止损0.5%/止盈10%本金）',
    '══════════════════════════════',
    `💰 总盈利: ${totalProfit.toFixed(2)} USDT (${profitCount}笔)`,
    `📉 总亏损: ${totalLoss.toFixed(2)} USDT (${lossCount}笔)`,
    `📊 净盈亏: ${netProfit.toFixed(2)} USDT`,
    `🎯 胜率: ${winRate.toFixed(1)}%`,
    `⚠️ 最大回撤: ${maxDrawdownPct.toFixed(2)}%本金`,
    `📝 总交易数: ${trades.length}笔`,
    '══════════════════════════════',
    `📅 统计时间: ${now.toLocaleString()}`
  ].join('\n');

  await bot.sendMessage(config.telegram.chatId, message, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 刷新数据', callback_data: 'show_daily_stats_other' }],
        [{ text: '🔙 返回主菜单', callback_data: 'back_to_main' }]
      ]
    }
  });
}

// 全局变量存储小时统计数据
let cachedHourlyStats = [];
let cachedTotalPages = 1;

/**
 * 发送所有历史数据按小时分组的交易统计数据
 */
async function sendAllHourlyStats() {
  const bot = require('./state').getBot();
  const db = require('../db').db;

  // 获取所有历史交易记录
  const trades = db.prepare(`
        SELECT * FROM trades 
        WHERE status = 'closed'
        ORDER BY exit_time
    `).all();

  if (trades.length === 0) {
    await sendTelegramMessage('📊 没有历史交易记录');
    return;
  }

  // 按小时分组（0-23）
  const hourlyStats = {};
  const maxAllowedLossPct = 0.5; // 10倍杠杆下的5%→0.5%本金

  // 初始化24个小时的空统计
  for (let hour = 0; hour < 24; hour++) {
    hourlyStats[hour] = {
      hour: `${hour.toString().padStart(2, '0')}:00-${(hour + 1).toString().padStart(2, '0')}:00`,
      totalProfit: 0,
      totalLoss: 0,
      profitCount: 0,
      lossCount: 0,
      maxDrawdownPct: 0,
      totalTrades: 0
    };
  }

  // 处理每笔交易
  trades.forEach(trade => {
    const exitTime = new Date(trade.exit_time);
    const hour = exitTime.getHours(); // 获取小时数（0-23）

    // 计算实际盈亏
    const actualProfit = trade.side === 'BUY'
      ? (trade.exit_price - trade.entry_price) * trade.quantity
      : (trade.entry_price - trade.exit_price) * trade.quantity;

    // 计算最大允许亏损金额（0.5%本金）
    const maxAllowedLossAmount = trade.entry_price * trade.quantity * maxAllowedLossPct / 100;

    let adjustedProfit;
    if (trade.side === 'BUY') {
      // 做多：计算最大潜在亏损（开仓价到最低价）
      const maxPotentialLoss = (trade.entry_price - trade.kline_low) * trade.quantity;
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
    } else {
      // 做空：计算最大潜在亏损（最高价到开仓价）
      const maxPotentialLoss = (trade.kline_high - trade.entry_price) * trade.quantity;
      adjustedProfit = maxPotentialLoss > maxAllowedLossAmount
        ? -maxAllowedLossAmount
        : actualProfit;
    }

    // 更新小时统计
    if (adjustedProfit > 0) {
      hourlyStats[hour].totalProfit += adjustedProfit;
      hourlyStats[hour].profitCount++;
    } else {
      hourlyStats[hour].totalLoss += Math.abs(adjustedProfit);
      hourlyStats[hour].lossCount++;

      // 计算实际回撤百分比
      const drawdownPct = (Math.abs(adjustedProfit) / (trade.entry_price * trade.quantity)) * 100;
      if (drawdownPct > hourlyStats[hour].maxDrawdownPct) {
        hourlyStats[hour].maxDrawdownPct = drawdownPct;
      }
    }
    hourlyStats[hour].totalTrades++;
  });

  // 过滤掉没有交易的小时段并排序
  cachedHourlyStats = Object.values(hourlyStats)
    .filter(h => h.totalTrades > 0)
    .sort((a, b) => parseInt(a.hour.split(':')[0]) - parseInt(b.hour.split(':')[0]));

  cachedTotalPages = Math.ceil(cachedHourlyStats.length / 6);

  if (cachedHourlyStats.length === 0) {
    await sendTelegramMessage('📊 所有时段均无交易记录');
    return;
  }

  // 发送第一页
  await sendHourlyStatsPage(1);
}

/**
 * 发送分页的小时统计结果
 * @param {number} page 当前页码
 */
async function sendHourlyStatsPage(page) {
  const bot = require('./state').getBot();
  const startIdx = (page - 1) * 6;
  const endIdx = Math.min(startIdx + 6, cachedHourlyStats.length);
  const pageStats = cachedHourlyStats.slice(startIdx, endIdx);

  let message = `⏰ 全历史分时段统计（${page}/${cachedTotalPages}）\n`;
  message += '══════════════════════════════\n';

  pageStats.forEach(stat => {
    const netProfit = stat.totalProfit - stat.totalLoss;
    const winRate = stat.totalTrades > 0
      ? (stat.profitCount / stat.totalTrades * 100)
      : 0;

    message += `🕒 ${stat.hour}\n`;
    message += `├─ 净盈亏: ${netProfit.toFixed(2)} USDT\n`;
    message += `├─ 交易数: ${stat.totalTrades}笔\n`;
    message += `├─ 胜率: ${winRate.toFixed(1)}%\n`;
    message += `└─ 最大回撤: ${stat.maxDrawdownPct.toFixed(2)}%本金\n`;
    message += '══════════════════════════════\n';
  });

  message += `📌 10倍杠杆，最大亏损0.5%本金/笔`;

  // 分页按钮
  const buttons = [];
  if (page > 1) {
    buttons.push({ text: '◀ 上一页', callback_data: `hourly_page_${page - 1}` });
  }
  if (page < cachedTotalPages) {
    buttons.push({ text: '下一页 ▶', callback_data: `hourly_page_${page + 1}` });
  }

  await bot.sendMessage(config.telegram.chatId, message, {
    reply_markup: {
      inline_keyboard: [
        buttons,
        [{ text: '🔄 重新加载', callback_data: 'show_all_hourly_stats' },
        { text: '🔙 返回主菜单', callback_data: 'back_to_main' }]
      ]
    }
  });
}

/**
 * 统计24个时间段内不同盈利/亏损区间的交易占比
 * 分析以下8种情况：
 * 1. 最高点盈利 >10% 的占比
 * 2. 实际盈利 >10% 的占比
 * 3. 最高点盈利 5%-10% 的占比
 * 4. 实际盈利 5%-10% 的占比
 * 5. 最低点亏损 >10% 的占比
 * 6. 实际亏损 >10% 的占比
 * 7. 最低点亏损 5%-10% 的占比
 * 8. 实际亏损 5%-10% 的占比
 */
async function analyzeHourlyProfitRatios(page = 0) {
  const bot = require('./state').getBot();
  const db = require('../db').db;
  const now = new Date();

  // 获取所有交易记录
  const allTrades = db.prepare(`
        SELECT * FROM trades 
        WHERE status = 'closed'
        ORDER BY exit_time ASC
    `).all();

  if (allTrades.length === 0) {
    await bot.sendMessage(config.telegram.chatId, '📊 没有可分析的交易记录');
    return;
  }

  // 初始化24小时段的统计对象
  const hourlyStats = Array(24).fill().map((_, hour) => ({
    hour: `${hour}:00-${hour + 1}:00`,
    totalTrades: 0,
    // 盈利统计
    profitStats: {
      highOver10: 0,    // 最高点盈利>10%
      actualOver10: 0,  // 实际盈利>10%
      high5To10: 0,     // 最高点盈利5%-10%
      actual5To10: 0,   // 实际盈利5%-10%
    },
    // 亏损统计
    lossStats: {
      lowOver10: 0,     // 最低点亏损>10%
      actualOver10: 0,  // 实际亏损>10%
      low5To10: 0,     // 最低点亏损5%-10%
      actual5To10: 0    // 实际亏损5%-10%
    }
  }));

  // 分析每笔交易
  allTrades.forEach(trade => {
    const exitTime = new Date(trade.exit_time);
    const hour = exitTime.getHours();
    const stats = hourlyStats[hour];
    stats.totalTrades++;

    // 计算开仓价值
    const entryValue = trade.entry_price * trade.quantity;

    // 计算各类百分比（10倍杠杆）
    const maxProfitPct = trade.side === 'BUY'
      ? (trade.kline_high - trade.entry_price) / trade.entry_price * 1000
      : (trade.entry_price - trade.kline_low) / trade.entry_price * 1000;

    const actualProfitPct = trade.side === 'BUY'
      ? (trade.exit_price - trade.entry_price) / trade.entry_price * 1000
      : (trade.entry_price - trade.exit_price) / trade.entry_price * 1000;

    const maxLossPct = trade.side === 'BUY'
      ? (trade.entry_price - trade.kline_low) / trade.entry_price * 1000
      : (trade.kline_high - trade.entry_price) / trade.entry_price * 1000;

    const actualLossPct = Math.abs(actualProfitPct) * (actualProfitPct < 0 ? 1 : 0);

    // 统计盈利情况
    if (maxProfitPct > 10) stats.profitStats.highOver10++;
    if (actualProfitPct > 10) stats.profitStats.actualOver10++;
    if (maxProfitPct >= 5 && maxProfitPct <= 10) stats.profitStats.high5To10++;
    if (actualProfitPct >= 5 && actualProfitPct <= 10) stats.profitStats.actual5To10++;

    // 统计亏损情况
    if (actualProfitPct < 0) {
      if (maxLossPct > 10) stats.lossStats.lowOver10++;
      if (actualLossPct > 10) stats.lossStats.actualOver10++;
      if (maxLossPct >= 5 && maxLossPct <= 10) stats.lossStats.low5To10++;
      if (actualLossPct >= 5 && actualLossPct <= 10) stats.lossStats.actual5To10++;
    }
  });

  // 分页设置 - 每页显示6个小时段
  const itemsPerPage = 6;
  const totalPages = Math.ceil(hourlyStats.length / itemsPerPage);
  const startIndex = page * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, hourlyStats.length);
  const currentPageStats = hourlyStats.slice(startIndex, endIndex);

  // 生成更易读的统计消息
  let message = '📈 24小时交易时段分析（10倍杠杆）\n';
  message += '══════════════════════════════\n';
  message += `📑 页码: ${page + 1}/${totalPages}\n`;
  message += '🔍 说明：\n';
  message += '- 最高盈利：K线期间达到的最大潜在盈利\n';
  message += '- 实际盈利：平仓时的实际盈利\n';
  message += '- 所有百分比基于10倍杠杆计算\n';
  message += '══════════════════════════════\n\n';

  currentPageStats.forEach(stats => {
    if (stats.totalTrades === 0) {
      message += `⏰ 时段 ${stats.hour} (无交易数据)\n`;
      message += '────────────────────\n';
      return;
    }

    // 计算各项占比
    const calcPct = (count) => (count / stats.totalTrades * 100).toFixed(1);

    message += `⏰ 时段 ${stats.hour} (${stats.totalTrades}笔交易)\n`;

    // 盈利部分
    message += '  🟢 盈利情况:\n';
    message += `  - 最高盈利 >10%: ${calcPct(stats.profitStats.highOver10)}%\n`;
    message += `  - 实际盈利 >10%: ${calcPct(stats.profitStats.actualOver10)}%\n`;
    message += `  - 最高盈利 5%-10%: ${calcPct(stats.profitStats.high5To10)}%\n`;
    message += `  - 实际盈利 5%-10%: ${calcPct(stats.profitStats.actual5To10)}%\n`;

    // 亏损部分
    message += '  🔴 亏损情况:\n';
    message += `  - 最大亏损 >10%: ${calcPct(stats.lossStats.lowOver10)}%\n`;
    message += `  - 实际亏损 >10%: ${calcPct(stats.lossStats.actualOver10)}%\n`;
    message += `  - 最大亏损 5%-10%: ${calcPct(stats.lossStats.low5To10)}%\n`;
    message += `  - 实际亏损 5%-10%: ${calcPct(stats.lossStats.actual5To10)}%\n`;

    message += '────────────────────\n';
  });

  message += `\n📅 统计截止时间: ${now.toLocaleString()}`;

  // 构建分页按钮
  const paginationButtons = [];
  if (page > 0) {
    paginationButtons.push({ text: '⬅️ 上一页', callback_data: `hourly_stats_page_${page - 1}` });
  }
  if (page < totalPages - 1) {
    paginationButtons.push({ text: '➡️ 下一页', callback_data: `hourly_stats_page_${page + 1}` });
  }

  const keyboard = [];
  if (paginationButtons.length > 0) {
    keyboard.push(paginationButtons);
  }
  keyboard.push(
    [{ text: '🔄 刷新数据', callback_data: `hourly_stats_page_${page}` }],
    [{ text: '📊 查看图表', callback_data: 'show_hourly_chart' }],
    [{ text: '🔙 返回主菜单', callback_data: 'back_to_main' }]
  );

  await bot.sendMessage(config.telegram.chatId, message, {
    reply_markup: {
      inline_keyboard: keyboard
    },
    parse_mode: 'Markdown'
  });
}

/**
 * 处理 Telegram 按钮指令
 * @param {string} data 按钮回调数据
 * @param {number} chatId 用户聊天 ID
 */
async function handleCommand(data, chatId) {
  if (data === 'start') {
    serviceStatus.running = true;
    sendTelegramMessage('✅ 策略已启动');
  } else if (data === 'stop') {
    serviceStatus.running = false;
    sendTelegramMessage('⏸ 策略已暂停');
  } else if (data === 'run_now') {
    sendTelegramMessage('🚀 手动执行策略...');
    await runStrategyCycle();
  } else if (data === 'status') {
    const selectedSymbol = getSelectedSymbol();  // 是字符串，比如 'BTCUSDT'
    const cachedRatio = getCachedPositionRatio();
    const strategyType = getStrategyType();
    const orderMode = getOrderMode(); // 读取当前模式
    let directionText = '无';
    if (selectedSymbol) {
      const position = getPosition(selectedSymbol);
      if (position?.side === 'BUY') {
        directionText = '做多';
      } else if (position?.side === 'SELL') {
        directionText = '做空';
      } else {
        directionText = '未持仓';
      }
    }

    const lines = [
      `📊 当前策略状态：`,
      `- 状态：${serviceStatus.running ? '✅ 运行中' : '⏸ 暂停中'}`,
      ...(strategyType !== 'ema_boll' ? [
        `- 选中币种：${selectedSymbol || '无'}`,
        `- 方向：${directionText}`,
        `- 最新下单比例：${cachedRatio * 100}%`
      ] : []),
      `- 策略类型：${strategyType}`,
      `- 当前策略模式：${getSignalMode() == 'NEGATE' ? '取反' : '取正'}`,
      `-下单状态：${orderMode === 'ratio' ? '按比例下单' : '固定金额下单'}`
    ];

    const statusText = lines.join('\n');
    sendTelegramMessage(statusText);
  } else if (data === 'refresh_top50') {
    await cacheTopSymbols(); // 刷新 Top50 缓存
    sendTelegramMessage('✅ 已刷新24小时交易量 Top50 币种');
    // 注意这里保留刷新按钮面板，因为如果T50数据都变了，那面板数据理应跟着改变
    await sendMainMenu();
  } else if (data === 'refresh_signal') {
    await sendMainMenu(); // 单独刷新多空信号按钮面板
    sendTelegramMessage('🔄 已刷新多空数据按钮面板');
  } else if (data === 'refresh_position') {
    await refreshPositionsFromBinance();
    sendTelegramMessage('📦 持仓已刷新（从币安获取最新）');
  } else if (data.startsWith('long_') || data.startsWith('short_')) {
    const symbol = data.split('_')[1];
    const isLong = data.startsWith('long_');
    const direction = isLong ? '做多' : '做空';
    cacheSelectedSymbol(symbol);
    sendTelegramMessage(`📌 已选择币种：${symbol}，方向：${direction}`);

    try {
      const orderSide = isLong ? 'BUY' : 'SELL';
      if (serviceStatus.running) {
        await placeOrder(symbol, orderSide); // 策略运行时才下单
      } else {
        sendTelegramMessage('⚠️ 当前策略已暂停，仅缓存选币，不会下单');
      }
    } catch (err) {
      console.error(`下单失败: ${symbol}`, err.message);
    }
    refreshPositionsFromBinance()
  } else if (data === 'clear_selected') {
    clearSelectedSymbol();
    sendTelegramMessage('🧹 已清空选中币种缓存');
  } else if (data.startsWith('ratio_')) {
    const ratio = parseFloat(data.split('_')[1]);
    if (!isNaN(ratio)) {
      cachePositionRatio(ratio);
      sendTelegramMessage(`✅ 下单比例已设置为 ${ratio * 100}%`);
    } else {
      sendTelegramMessage('❌ 比例设置失败，格式不正确');
    }
  } else if (data.startsWith('set_strategy_')) {
    const strategyId = data.replace('set_strategy_', '');
    const strategy = getAllStrategies().find(s => s.id === strategyId);
    if (strategy) {
      setStrategyType(strategy.id);
      sendTelegramMessage(`✅ 当前策略已切换为：${strategy.name}`);
      await sendMainMenu(); // 刷新按钮状态
    } else {
      sendTelegramMessage('❌ 未找到该策略类型');
    }
  } else if (data === 'order_mode_ratio') {
    setOrderMode('ratio');
    sendTelegramMessage('📊 已切换为按比例下单模式');
    await sendMainMenu(); // 刷新按钮状态

  } else if (data === 'order_mode_amount') {
    setOrderMode('amount');
    sendTelegramMessage('💵 已切换为固定金额下单模式');
    await sendMainMenu(); // 刷新按钮状态
  } else if (data === 'show_symbol_list') {
    await sendSymbolFilterMenu();
    sendTelegramMessage('📋 查看策略币种列表');
  } else if (data.startsWith('delete_symbol_')) {
    const symbol = data.replace('delete_symbol_', '');
    removeFromTopSymbols(symbol)
    await sendTelegramMessage(`✅ 已从策略列表中移除：${symbol}`);
  } else if (data === 'toggle_signal_mode') {
    const newMode = toggleSignalMode();
    await sendTelegramMessage(`✅ 当前信号模式为：${newMode == 'NEGATE' ? '取反' : '取正'}`);
  } else if (data === 'show_stats') {
    await sendStatsPage(1);
  }
  else if (data.startsWith('stats_page_')) {
    const page = parseInt(data.replace('stats_page_', ''));
    await sendStatsPage(page);
  }
  else if (data === 'back_to_main') {
    await sendMainMenu();
  }
  else if (data === 'show_daily_stats') {
    await sendDailyStats();
  }
  else if (data === 'show_daily_stats_other') {
    await sendDailyStatsOther();
  }
  else if (data === 'show_all_hourly_stats') {
    await sendAllHourlyStats();
  }
  else if (data === 'analyze_hourly_profit_ratios') {
    await analyzeHourlyProfitRatios();
  }
  else if (data.startsWith('hourly_stats_page_')) {
    const page = parseInt(data.split('_')[3]);
    await analyzeHourlyProfitRatios(page);
  }
  else if (data.startsWith('hourly_page_')) {
    const page = parseInt(data.replace('hourly_page_', ''));
    if (page >= 1 && page <= cachedTotalPages) {
      await sendHourlyStatsPage(page);
    } else {
      await sendTelegramMessage('⚠️ 页码无效，正在返回第一页');
      await sendHourlyStatsPage(1);
    }
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage,   // 方便外部直接发送消息（内部会通过 state 获取bot）
  serviceStatus
};
