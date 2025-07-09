启动方式：
pm2 start ecosystem.config.js

pm2 logs binance-strategy
pm2 flush binance-strategy

pm2 delete binance-strategy

# 查找进程ID
ps aux | grep node

# 终止进程
kill -9 <PID>

node test/telegram-test.js