// utils/tg-settings.js
// NEGATE 取反 NEGATE 取正
const tgSettings = {
  signalMode: 'NEGATE', // 可为 'A' 或 'B'
};

function toggleSignalMode() {
  tgSettings.signalMode = tgSettings.signalMode === 'NEGATE' ? 'CORRECT' : 'NEGATE';
  return tgSettings.signalMode;
}

function getSignalMode() {
  return tgSettings.signalMode;
}

module.exports = {
  getSignalMode,
  toggleSignalMode,
};
