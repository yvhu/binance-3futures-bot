require('dotenv').config();

module.exports = {
  // 策略使用的K线周期（如3分钟）
  interval: '3m',

  // 每次选取做多或做空的币种数量（Top N）
  selectionCount: 5,

  // 使用的杠杆倍数（10倍杠杆）
  leverage: 10,

  // 每次下单占用的USDT比例（如10%，即总资金的10%）
  positionRatio: 0.1,

  // ================== EMA 均线设置 ==================
  ema: {
    shortPeriod: 7,     // 短期 EMA（如7）用于快速反应价格变化，常用于捕捉买卖信号
    longPeriod: 21      // 长期 EMA（如21）用于趋势确认，与短期EMA形成金叉/死叉信号
  },

  // ================== 布林带指标设置 ==================
  bb: {
    period: 20,         // 布林带周期，表示使用多少根K线计算布林带（通常20为标准）
    stdDev: 2           // 标准差倍数，用于确定上下轨距离（通常设置为2）
  },

  // 连续阴线数量阈值（如达到3根阴线触发平仓）
  maxRedCandles: 3,

  // 连续K线数量判断平仓时的K线处于BOLL中线位置，默认为2
  continuousKlineCount: 2,

  // 最近 N 根K线交叉判断窗口
  signalValidCandles: 3,

  // 金叉/死叉后多少根K线内有效
  signalValidCandles: 3,

  // 最大持仓时间（单位：分钟，超过后强制平仓）
  maxPositionMinutes: 180,

  // Telegram 配置
  telegram: {
    // Telegram 机器人 Token（可放入 .env 文件）
    token: process.env.TELEGRAM_TOKEN || 'your-token',
    // 目标聊天的 chatId，可是个人ID或群组ID
    chatId: process.env.TELEGRAM_CHAT_ID || 'your-chat-id'
  },

  // 币安接口配置
  binance: {
    apiKey: process.env.BINANCE_API_KEY || 'your-token',
    apiSecret: process.env.BINANCE_SECRET_KEY || 'your-token',
    // 币安合约交易接口基础地址（如需切换到测试网可改为 testnet 地址）
    baseUrl: 'https://fapi.binance.com',
    // 各种 API 接口路径
    endpoints: {
      ticker24hr: '/fapi/v1/ticker/24hr', // 获取24小时行情数据
      price: '/fapi/v1/ticker/price',     // 获取最新市价
      klines: '/fapi/v1/klines'           // 获取K线数据
    }
  },

  // 缓存文件路径配置
  cachePaths: {
    // Top50 币种列表缓存路径
    top50: './cache/top50.json',
    // 用户选择的交易币种缓存路径
    selectedSymbol: './cache/selected-symbol.json',
    // 新增：币种精度缓存路径
    precision: './cache/precision.json',
    // 新增：持仓记录缓存
    position: './cache/position.json'
  }
};
