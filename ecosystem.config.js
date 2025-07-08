module.exports = {
  apps: [
    {
      name: 'binance-strategy',
      script: './index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai' // ⬅️ 设置为北京时间
      }
    }
  ]
};
