// rebuild-db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data/database.sqlite');

// 确保目录存在
if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// 删除旧文件（如果存在）
if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
}

// 创建新数据库
const db = new Database(DB_PATH);

// 初始化所有表
function initTables() {
    try {
        // 初始化 hourly_stats 表
        require('./db/hourlyStats.js').init(db);
        
        // 初始化其他表
        require('./db/trade.js').init(db);
        require('./db/log.js').init(db);
        
        console.log('✅ 所有表初始化完成');
    } catch (err) {
        console.error('❌ 初始化失败:', err);
        process.exit(1);
    }
}

initTables();
db.close();