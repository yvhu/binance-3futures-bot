const { getTopSymbols } = require('../binance/market');



// 判断单边行情的主函数
async function checkMarketTrend() {
    try {
        // 获取所有交易对和24小时数据
        const tickerData = await getTopSymbols();
        
        if (tickerData.length === 0) {
            return { isOneSided: false, trend: 'neutral', confidence: 0, details: {} };
        }

        let upCount = 0;
        let downCount = 0;
        let totalSymbols = 0;
        let totalPriceChangePercent = 0;
        let significantMovers = 0;

        const trendDetails = {
            symbols: [],
            summary: {
                total: 0,
                up: 0,
                down: 0,
                averageChange: 0
            }
        };

        // 分析每个交易对
        for (const ticker of tickerData) {
            const priceChangePercent = parseFloat(ticker.priceChangePercent);
            
            if (!isNaN(priceChangePercent)) {
                totalSymbols++;
                totalPriceChangePercent += priceChangePercent;

                // 统计涨跌数量
                if (priceChangePercent > 0) {
                    upCount++;
                } else if (priceChangePercent < 0) {
                    downCount++;
                }

                // 统计显著变动（涨跌幅超过1%）
                if (Math.abs(priceChangePercent) > 1) {
                    significantMovers++;
                }

                trendDetails.symbols.push({
                    symbol: ticker.symbol,
                    priceChangePercent: priceChangePercent,
                    trend: priceChangePercent > 0 ? 'up' : priceChangePercent < 0 ? 'down' : 'neutral'
                });
            }
        }

        // 计算比例和平均值
        const upRatio = upCount / totalSymbols;
        const downRatio = downCount / totalSymbols;
        const averageChange = totalPriceChangePercent / totalSymbols;
        const significantRatio = significantMovers / totalSymbols;

        trendDetails.summary = {
            total: totalSymbols,
            up: upCount,
            down: downCount,
            upRatio: upRatio,
            downRatio: downRatio,
            averageChange: averageChange,
            significantMovers: significantMovers,
            significantRatio: significantRatio
        };

        // 判断是否单边行情
        let isOneSided = false;
        let trend = 'neutral';
        let confidence = 0;

        // 单边上涨行情判断条件
        if (upRatio > 0.7 && averageChange > 0.5 && significantRatio > 0.6) {
            isOneSided = true;
            trend = 'bullish';
            confidence = Math.min(upRatio * 100, 90);
        }
        // 单边下跌行情判断条件
        else if (downRatio > 0.7 && averageChange < -0.5 && significantRatio > 0.6) {
            isOneSided = true;
            trend = 'bearish';
            confidence = Math.min(downRatio * 100, 90);
        }
        // 强烈单边行情（超过85%的币种同向）
        else if (upRatio > 0.85 || downRatio > 0.85) {
            isOneSided = true;
            trend = upRatio > downRatio ? 'strong_bullish' : 'strong_bearish';
            confidence = 95;
        }

        return {
            isOneSided,
            trend,
            confidence,
            details: trendDetails
        };

    } catch (error) {
        console.error('分析市场趋势失败:', error.message);
        return { isOneSided: false, trend: 'error', confidence: 0, details: {} };
    }
}

module.exports = {
    checkMarketTrend
};