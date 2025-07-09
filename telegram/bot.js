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

let serviceStatus = {
  running: false
};

/**
 * 初始化 Telegram Bot，启动监听，绑定回调事件
 */
async function initTelegramBot() {
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  setBot(bot); // 设置全局 bot 实例，供其他模块获取

  log('🤖 Telegram Bot 已启动');

  bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    await handleCommand(data, chatId);
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

  const buttons = [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新多空数据', callback_data: 'refresh_signal' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }, { text: '🧹 清空已选币种', callback_data: 'clear_selected' }]
  ];

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

  await bot.sendMessage(config.telegram.chatId, '🎯 策略控制面板', {
    reply_markup: {
      inline_keyboard: buttons
    }
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
    const statusText = `📊 当前策略状态：
- 状态：${serviceStatus.running ? '✅ 运行中' : '⏸ 暂停中'}
- 选中币种：${selectedSymbol || '无'}
- 方向：${directionText}`;
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
  } else if (data === 'clear_selected') {
    clearSelectedSymbol();
    sendTelegramMessage('🧹 已清空选中币种缓存');
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage,   // 方便外部直接发送消息（内部会通过 state 获取bot）
  serviceStatus
};
