require('dotenv').config();

module.exports = {
  // 策略使用的K线周期（如3分钟）
  interval: '3m',

  // 每次选取做多或做空的币种数量（Top N）
  selectionCount: 5,

  // 使用的杠杆倍数（10倍杠杆）
  leverage: 10,

  // 每次下单占用的USDT比例（如10%，即总资金的10%）
  positionRatio: 1.0,

  // 连续阴线数量阈值（如达到3根阴线触发平仓）
  maxRedCandles: 3,

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
    selectedSymbol: './cache/selected-symbol.json'
  }
};
