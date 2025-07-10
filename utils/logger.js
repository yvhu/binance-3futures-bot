const moment = require('moment-timezone');
function log(...args) {
  // console.log(`[${new Date().toISOString()}]`, ...args);
  console.log(`[${moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss.SSS')}]`, ...args);
}
module.exports = { log };
