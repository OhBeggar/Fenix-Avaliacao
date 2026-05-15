// E:\\0IA\\avali\\ecosystem.config.js
module.exports = {
  apps: [{
    name: "fenix-avaliacao",
    script: "app.js",
    cwd: "E:\\0IA\\avali",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "2G",
    env: {
      NODE_ENV: "production",
      PORT: 5000,
      HOST: "0.0.0.0"
    },
    error_file: "logs\\err.log",
    out_file: "logs\\out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss"
  }]
}