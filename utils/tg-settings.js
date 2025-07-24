// utils/tg-settings.js
// NEGATE 取反 NEGATE 取正
const tgSettings = {
  signalMode: 'CORRECT', // 可为 'A' 或 'B'
};

function toggleSignalMode() {
  tgSettings.signalMode = tgSettings.signalMode === 'CORRECT' ? 'NEGATE' : 'CORRECT';
  return tgSettings.signalMode;
}

function getSignalMode() {
  return tgSettings.signalMode;
}

module.exports = {
  getSignalMode,
  toggleSignalMode,
};
