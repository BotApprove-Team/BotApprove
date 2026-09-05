// Alternative to the systemd unit, if you prefer pm2.
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'botapprove',
    script: 'src/index.js',
    cwd: '/opt/botapprove',
    instances: 1,
    exec_mode: 'fork',       // SQLite + a single gateway connection: never cluster
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
  }],
};
