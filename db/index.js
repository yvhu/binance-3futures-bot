// db/index.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(__dirname, '../data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

// 单例数据库连接
const db = new Database(path.join(DB_PATH, 'database.sqlite')); // 不写 verbose 即可

// 引入子模块初始化函数
const log = require('./log');
// const position = require('./position');
// 可按需引入更多

// 初始化所有表
function initTables() {
  log.init(db);
//   position.init(db);
  // 更多表初始化...
}

module.exports = {
  db,
  initTables,
  log,
//   position,
  // 更多表导出
};
