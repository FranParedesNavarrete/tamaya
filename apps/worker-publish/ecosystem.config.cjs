// pm2 ecosystem — gestiona el proceso del worker publish en el host
// https://pm2.keymetrics.io/docs/usage/application-declaration/
module.exports = {
  apps: [
    {
      name: 'tamaya-worker-publish',
      script: 'dist/index.js',
      cwd: __dirname,
      exec_mode: 'fork',        // NO cluster — Chromium no tolera multi-fork
      instances: 1,             // 1 por cuenta WA
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
    },
  ],
};
