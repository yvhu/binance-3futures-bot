// db/trade.js
const moment = require('moment-timezone');
module.exports = {
    init(db) {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                entry_time DATETIME NOT NULL,
                entry_price REAL NOT NULL,
                order_amount REAL NOT NULL,
                quantity REAL NOT NULL,
                side TEXT NOT NULL,
                exit_price REAL,
                exit_time DATETIME,
                profit REAL,
                status TEXT DEFAULT 'open'
            )
        `).run();
    },

    /**
     * 记录新交易
     * @param {string} symbol 交易对
     * @param {number} price 入场价格
     * @param {number} qtyRaw 数量
     * @param {string} side 方向(BUY/SELL)
     * @returns {number} 插入的ID
     */
    recordTrade(db, { symbol, price, qtyRaw, side }) {
        // const entryTime = new Date().toISOString();
        const entryTime = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');
        const orderAmount = 100; // 固定值

        const stmt = db.prepare(`
            INSERT INTO trades (symbol, entry_time, entry_price, order_amount, quantity, side)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(symbol, entryTime, price, orderAmount, qtyRaw, side);
        return info.lastInsertRowid;
    },

    /**
     * 平仓交易
     * @param {number} tradeId 交易ID
     * @param {number} exitPrice 平仓价格
     * @returns {boolean} 是否成功
     */
    closeTrade(db, tradeId, exitPrice) {
        // 获取原始交易信息
        const trade = db.prepare(`
            SELECT entry_price, quantity, side FROM trades 
            WHERE id = ? AND status = 'open'
        `).get(tradeId);

        if (!trade) return false;

        // 计算盈利
        const profit = trade.side === 'BUY'
            ? (exitPrice - trade.entry_price) * trade.quantity
            : (trade.entry_price - exitPrice) * trade.quantity;

        // const exitTime = new Date().toISOString();
        const exitTime = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss');

        // 更新交易记录
        const stmt = db.prepare(`
            UPDATE trades 
            SET exit_price = ?, exit_time = ?, profit = ?, status = 'closed'
            WHERE id = ?
        `);

        const info = stmt.run(exitPrice, exitTime, profit, tradeId);
        return info.changes > 0;
    },

    /**
     * 获取所有未平仓交易
     * @returns {Array} 未平仓交易列表
     */
    getOpenTrades(db) {
        return db.prepare(`
            SELECT * FROM trades WHERE status = 'open' ORDER BY entry_time
        `).all();
    },

    /**
     * 获取某个交易对的交易记录
     * @param {string} symbol 交易对
     * @returns {Array} 交易记录列表
     */
    getTradesBySymbol(db, symbol) {
        return db.prepare(`
            SELECT * FROM trades WHERE symbol = ? ORDER BY entry_time
        `).all(symbol);
    },

    /**
     * 获取总盈利
     * @returns {number} 总盈利金额
     */
    getTotalProfit(db) {
        const result = db.prepare(`
            SELECT SUM(profit) as total FROM trades WHERE status = 'closed'
        `).get();
        return result.total || 0;
    },

    /**
     * 根据交易对和方向获取未平仓交易
     * @param {string} symbol 交易对
     * @param {string} side 方向(BUY/SELL)
     * @returns {Object|null} 未平仓交易或null
     */
    getOpenTradeBySymbolAndSide(db, symbol, side) {
        return db.prepare(`
        SELECT * FROM trades 
        WHERE symbol = ? AND side = ? AND status = 'open'
        ORDER BY entry_time DESC
        LIMIT 1
    `).get(symbol, side);
    },
    /**
     * 根据交易对获取所有未平仓交易
     * @param {string} symbol 交易对
     * @returns {Array} 未平仓交易列表
     */
    getOpenTradesBySymbol(db, symbol) {
        return db.prepare(`
        SELECT * FROM trades 
        WHERE symbol = ? AND status = 'open'
        ORDER BY entry_time
    `).all(symbol);
    },
    /**
     * 根据时间范围获取交易记录
     * @param {string} startTime 开始时间(ISO格式)
     * @param {string} endTime 结束时间(ISO格式)
     * @returns {Array} 交易记录列表
     */
    getTradesByTimeRange(db, startTime, endTime) {
        return db.prepare(`
        SELECT * FROM trades 
        WHERE (entry_time BETWEEN ? AND ?) 
           OR (exit_time BETWEEN ? AND ?)
        ORDER BY COALESCE(exit_time, entry_time)
    `).all(startTime, endTime, startTime, endTime);
    },

    /**
     * 根据ID获取交易记录
     * @param {Database} db 数据库实例
     * @param {number} tradeId 交易ID
     * @returns {Object|null} 交易记录
     */
    getTradeById(db, tradeId) {
        return db.prepare(`
        SELECT * FROM trades WHERE id = ?
    `).get(tradeId);
    }
};