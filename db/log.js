// db/log.js
let dbRef;

function init(db) {
  dbRef = db;
  dbRef.prepare(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

function insert(type, message) {
  const stmt = dbRef.prepare(`INSERT INTO logs (type, message) VALUES (?, ?)`);
  stmt.run(type, message);
}

function list(limit = 20) {
  return dbRef.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

module.exports = {
  init,
  insert,
  list,
};
