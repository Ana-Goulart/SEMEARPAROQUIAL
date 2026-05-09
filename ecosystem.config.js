module.exports = {
  apps: [
    {
      name: 'SemearJovens',
      script: './SemearJovens/app.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3003
      },
      error_file: './logs/SemearJovens-error.log',
      out_file: './logs/SemearJovens-out.log',
      log_file: './logs/SemearJovens-combined.log',
      time: true
    },
    {
      name: 'SemearLogin',
      script: './SemearLogin/app.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3004
      },
      error_file: './logs/SemearLogin-error.log',
      out_file: './logs/SemearLogin-out.log',
      log_file: './logs/SemearLogin-combined.log',
      time: true
    }
  ]
};
