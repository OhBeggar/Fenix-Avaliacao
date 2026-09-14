module.exports = {
  apps: [{
    name: 'avali',
    script: 'app.js',
    cwd: __dirname,
    interpreter: require('path').join(__dirname, '.runtime', 'node-v24.20.0-win-x64', 'node.exe'),
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 5000,
      HOST: '0.0.0.0'
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};

