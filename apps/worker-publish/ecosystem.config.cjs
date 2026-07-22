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
    {
      // Control server: administración de sesión WhatsApp desde UI/API.
      // Ambos procesos pueden estar SIEMPRE vivos: el lock de perfil
      // (.tamaya-profile.lock) impide que abran Chromium a la vez y da un error
      // claro si coinciden. No hace falta pararlos manualmente.
      name: 'tamaya-worker-control',
      script: 'dist/control-server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/control-out.log',
      error_file: './logs/control-err.log',
      merge_logs: true,
    },
  ],
};
