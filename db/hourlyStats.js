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
                total_profit REAL NOT NULL DEFAULT 0,
                long_profit REAL NOT NULL DEFAULT 0,
                long_loss REAL NOT NULL DEFAULT 0,
                short_profit REAL NOT NULL DEFAULT 0,
                short_loss REAL NOT NULL DEFAULT 0,
                trade_count INTEGER NOT NULL DEFAULT 0,
                long_win_count INTEGER NOT NULL DEFAULT 0,
                long_loss_count INTEGER NOT NULL DEFAULT 0,
                short_win_count INTEGER NOT NULL DEFAULT 0,
                short_loss_count INTEGER NOT NULL DEFAULT 0,
                long_win_rate REAL NOT NULL DEFAULT 0,
                short_win_rate REAL NOT NULL DEFAULT 0,
                avg_profit_per_trade REAL NOT NULL DEFAULT 0,
                avg_return_rate REAL NOT NULL DEFAULT 0,
                max_return_rate REAL NOT NULL DEFAULT 0,
                min_return_rate REAL NOT NULL DEFAULT 0
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
            (
                hour, 
                total_profit, 
                long_profit, 
                long_loss,
                short_profit,
                short_loss,
                trade_count,
                long_win_count,
                long_loss_count,
                short_win_count,
                short_loss_count,
                long_win_rate,
                short_win_rate,
                avg_profit_per_trade,
                avg_return_rate,
                max_return_rate,
                min_return_rate
            ) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            stats.hour || new Date().toISOString(),
            stats.total_profit || 0,
            stats.long_profit || 0,
            stats.long_loss || 0,
            stats.short_profit || 0,
            stats.short_loss || 0,
            stats.trade_count || 0,
            stats.long_win_count || 0,
            stats.long_loss_count || 0,
            stats.short_win_count || 0,
            stats.short_loss_count || 0,
            stats.long_win_rate || 0,
            stats.short_win_rate || 0,
            stats.avg_profit_per_trade || 0,
            stats.avg_return_rate || 0,
            stats.max_return_rate || 0,
            stats.min_return_rate || 0
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
    },

    /**
     * 分页查询小时统计数据
     * @param {Database} db SQLite数据库实例
     * @param {number} page 页码（从1开始）
     * @param {number} pageSize 每页条数
     * @returns {Object} { data: 当前页数据, total: 总条数, pages: 总页数 }
     */
    getStatsByPage(db, page = 1, pageSize = 10) {
        const offset = (page - 1) * pageSize;

        return {
            data: db.prepare(`
            SELECT * FROM hourly_stats 
            ORDER BY hour DESC
            LIMIT ? OFFSET ?
        `).all(pageSize, offset),

            total: db.prepare(`
            SELECT COUNT(*) as total FROM hourly_stats
        `).get().total,

            pages: Math.ceil(db.prepare(`
            SELECT COUNT(*) as total FROM hourly_stats
        `).get().total / pageSize)
        };
    },
};