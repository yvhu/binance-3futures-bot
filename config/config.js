require('dotenv').config();

module.exports = {
  // 策略使用的K线周期（如3分钟）
  interval: '5m',

  // 每次选取做多或做空的币种数量（Top N）
  selectionCount: 5,

  // 波动率阈值，0.15% 实体视为低波动
  volatilityExitThreshold: 0.002, 

  // 使用的杠杆倍数（10倍杠杆）
  leverage: 10,

  // 止盈止损配置
  riskControl: {
    enableStopLoss: true,         // 是否启用止损单
    stopLossRate: 0.003,           // 止损触发比例（亏损 2% = 0.02）
    enableTakeProfit: true,      // 是否启用止盈单（预留）
    takeProfitRate: 0.002           // 止盈触发比例（盈利 10% = 0.1）
  },

  // 横盘逻辑配置
  sidewaysExit: {
    enable: true,                 // ✅ 是否启用横盘止盈逻辑（true 开启 / false 关闭）

    priceStdPeriod: 5,           // ✅ 标准差周期（例如最近10根K线）
    // 用于计算最近价格的波动性，越小表示越敏感

    priceStdThreshold: 0.002,     // ✅ 价格标准差阈值（0.002 表示波动率小于 0.2%）
    // 若价格波动率低于此值，认为价格波动非常小，进入横盘状态

    bollNarrowPeriod: 10,         // ✅ 布林带宽度判断周期（例如最近10根K线）
    // 用于检测布林带是否“缩口”（带宽变窄）

    bollNarrowThreshold: 0.01,    // ✅ 布林带宽度阈值（0.01 表示带宽小于中轨的 1%）
    // 如果布林带上下轨距离 / 中轨 小于这个比例，表示波动很小，也视为横盘

    minSidewaysDuration: 4        // ✅ 横盘最小持续周期（单位为 K线数量）
    // 只有连续满足“横盘状态”达到指定数量的K线，才触发止盈，避免短暂波动误判
  },


  // 最小持仓时间（分钟）
  minHoldingMinutes: 6,

  // 最低盈利率（小数形式，如0.01表示1%）
  minProfitRate: 0.05,

  // 每次下单占用的USDT比例（如10%，即总资金的10%）
  positionRatio: 0.1,

  // 'ratio' | 'amount'，默认 ratio
  orderMode: 'amount',
  // 当按金额下单时默认金额
  fixedAmountUSDT: 10,

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
  maxRedOrGreenCandles: 3,

  // 连续K线数量判断平仓时的K线处于BOLL中线位置，默认为2
  continuousKlineCount: 2,

  // 最近 N 根K线交叉判断窗口
  signalValidCandles: 3,

  // 金叉/死叉后多少根K线内有效
  signalValidCandles: 3,

  // 对比最近3根K线之前的价格
  priceChangeLookBack: 3,

  // 涨跌幅阈值5%
  priceChangeThreshold: 0.05,

  // 最大持仓时间（单位：分钟，超过后强制平仓）
  maxPositionMinutes: 180,

  // 盈利超过 100% 平仓
  profitThreshold: 1,

  // 亏损超过 -50% 平仓
  lossThreshold: -0.5,

  // Telegram 配置
  telegram: {
    // Telegram 机器人 Token（可放入 .env 文件）
    token: process.env.TELEGRAM_TOKEN || 'your-token',
    // 目标聊天的 chatId，可是个人ID或群组ID
    chatId: process.env.TELEGRAM_CHAT_ID || 'your-chat-id',
    // 控制是否启用代理
    useProxy: false,
    // 本地代理地址（无需认证）
    proxyUrl: 'http://127.0.0.1:7897'
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
    },
    // 控制是否启用代理
    useProxy: false,
    // 本地代理地址（无需认证）
    proxyUrl: 'http://127.0.0.1:7897'
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
    position: './cache/position.json',
    // 仓位比例设置
    patio: './cache/ratio.json'
  }
};
