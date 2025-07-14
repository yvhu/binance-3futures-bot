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
const { cachePositionRatio, getCachedPositionRatio } = require('../utils/cache');

const { HttpsProxyAgent } = require('https-proxy-agent');

let serviceStatus = {
  running: false
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

  const buttons = strategyType == 'ema_boll' ? [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新多空数据', callback_data: 'refresh_signal' }],
    [{ text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }, { text: '🧹 清空已选币种', callback_data: 'clear_selected' }]
  ]: [
    [{ text: '▶ 开启策略', callback_data: 'start' }, { text: '⏸ 暂停策略', callback_data: 'stop' }],
    [{ text: '🔁 立即执行', callback_data: 'run_now' }, { text: '📊 查看状态', callback_data: 'status' }],
    [{ text: '📦 刷新持仓信息', callback_data: 'refresh_position' }, { text: '♻️ 刷新 Top50 币种', callback_data: 'refresh_top50' }],
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
- 方向：${directionText}
- 最新下单比例：${cachedRatio * 100}%`;
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
  }
}

module.exports = {
  initTelegramBot,
  sendTelegramMessage,   // 方便外部直接发送消息（内部会通过 state 获取bot）
  serviceStatus
};
