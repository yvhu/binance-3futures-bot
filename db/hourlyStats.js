// db/hourlyStats.js
module.exports = {
    /**
     * 初始化小时统计表
     * @param {Database} db SQLite数据库实例
     */
    init(db) {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS hourly_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hour DATETIME NOT NULL,
                total_profit REAL NOT NULL,
                long_profit REAL NOT NULL,
                long_loss REAL NOT NULL,
                short_profit REAL NOT NULL,
                short_loss REAL NOT NULL,
                trade_count INTEGER NOT NULL,
                long_win_count INTEGER NOT NULL,
                long_loss_count INTEGER NOT NULL,
                short_win_count INTEGER NOT NULL,
                short_loss_count INTEGER NOT NULL,
                long_win_rate REAL NOT NULL,
                short_win_rate REAL NOT NULL,
                avg_profit_per_trade REAL NOT NULL,
                UNIQUE(hour)
            )
        `).run();
    },

    /**
     * 记录小时统计
     * @param {Database} db SQLite数据库实例
     * @param {Object} stats 统计信息
     */
    record(db, stats) {
        db.prepare(`
            INSERT OR REPLACE INTO hourly_stats 
            (hour, total_profit, long_profit, short_profit, trade_count, avg_profit_per_trade)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            stats.hour,
            stats.total_profit,
            stats.long_profit,
            stats.short_profit,
            stats.trade_count,
            stats.avg_profit_per_trade
        );
    },

    /**
     * 获取小时统计
     * @param {Database} db SQLite数据库实例
     * @param {number} hours 要获取的小时数(默认24小时)
     * @returns {Array} 统计记录列表
     */
    getStats(db, hours = 24) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        return db.prepare(`
            SELECT * FROM hourly_stats 
            WHERE hour >= ?
            ORDER BY hour DESC
        `).all(cutoff);
    },

    /**
     * 获取指定时间范围内的统计
     * @param {Database} db SQLite数据库实例
     * @param {string} startTime 开始时间(ISO格式)
     * @param {string} endTime 结束时间(ISO格式)
     * @returns {Array} 统计记录列表
     */
    getStatsByRange(db, startTime, endTime) {
        return db.prepare(`
            SELECT * FROM hourly_stats 
            WHERE hour BETWEEN ? AND ?
            ORDER BY hour
        `).all(startTime, endTime);
    }
};