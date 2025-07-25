const { db, trade } = require('../db');
/**
 * CREATE TABLE IF NOT EXISTS trades (
    -- 交易记录唯一标识符，自增主键
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- 交易对/交易品种，例如 'BTCUSDT' 表示比特币兑USDT
    symbol TEXT NOT NULL,
    
    -- 开仓时间，使用ISO8601格式(YYYY-MM-DD HH:MM:SS.SSS)
    entry_time DATETIME NOT NULL,
    
    -- 开仓价格，记录交易建立时的市场价格
    entry_price REAL NOT NULL,
    
    -- 订单金额(固定值)，表示这笔交易的总价值
    -- 根据您的代码，这个值固定为100
    order_amount REAL NOT NULL,
    
    -- 交易数量/仓位大小，表示买入或卖出的资产数量
    -- 例如BTCUSDT交易可能是0.01 BTC
    quantity REAL NOT NULL,
    
    -- 交易方向: 'BUY'表示做多(买入)，'SELL'表示做空(卖出)
    side TEXT NOT NULL,
    
    -- 平仓价格，当交易平仓时记录的市场价格
    -- 开仓时此字段为NULL
    exit_price REAL,
    
    -- 平仓时间，使用ISO8601格式
    -- 开仓时此字段为NULL
    exit_time DATETIME,
    
    -- 盈利金额，根据开仓价和平仓价计算的盈亏
    -- 正值表示盈利，负值表示亏损
    -- 开仓时此字段为NULL
    profit REAL,
    
    -- 交易状态: 
    -- 'open'表示持仓中(未平仓)
    -- 'closed'表示已平仓
    -- 默认为'open'
    status TEXT DEFAULT 'open'
);
 */
// 记录新交易
const tradeId = trade.recordTrade(db, {
    symbol: 'BTCUSDT',
    price: 50000,
    qtyRaw: 0.002,
    side: 'BUY'
});

// 平仓交易
const success = trade.closeTrade(db, tradeId, 52000);

// 获取未平仓交易
const openTrades = trade.getOpenTrades(db);

// 获取某个交易对的记录
const btcTrades = trade.getTradesBySymbol(db, 'BTCUSDT');

// 获取总盈利
const totalProfit = trade.getTotalProfit(db);