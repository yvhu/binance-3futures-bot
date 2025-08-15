// ============= 当前最新拆分公共函数 ============

function isInTradingTimeRange(timeRanges) {
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTime = currentHours * 100 + currentMinutes; // 转换为数字便于比较 如0930

  return timeRanges.some(range => {
    const [startHour, startMinute] = range.start.split(':').map(Number);
    const [endHour, endMinute] = range.end.split(':').map(Number);

    const startTime = startHour * 100 + startMinute;
    const endTime = endHour * 100 + endMinute;

    return currentTime >= startTime && currentTime <= endTime;
  });
}

module.exports = {
  isInTradingTimeRange,
};