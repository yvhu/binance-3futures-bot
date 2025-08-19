const { getCachedTopSymbols } = require('../utils/cache');
const { analyzeSymbol } = require('../indicators/analyzer');
const config = require('../config/config');
const { log } = require('../utils/logger');

async function selectBestSymbols() {
  const topSymbols = getCachedTopSymbols();
  const longCandidates = [];
  const shortCandidates = [];

  for (const symbol of topSymbols) {
    try {
      const result = await analyzeSymbol(symbol, config.interval);
      if (result.shouldLong) longCandidates.push({ symbol, score: result.score });
      if (result.shouldShort) shortCandidates.push({ symbol, score: result.score });
    } catch (err) {
      log(`❌ 分析失败: ${symbol}`, err.message);
    }
  }

  // 按评分降序排序
  longCandidates.sort((a, b) => b.score - a.score);
  shortCandidates.sort((a, b) => b.score - a.score);

  return {
    longList: longCandidates.slice(0, config.selectionCount),
    shortList: shortCandidates.slice(0, config.selectionCount)
  };
}

module.exports = {
  selectBestSymbols
};
