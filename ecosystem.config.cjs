// pm2: `pm2 start ecosystem.config.cjs && pm2 save`
// Secrets live in a .env file next to server.js (git-ignored); the server loads it on start.
module.exports = {
  apps: [
    {
      name: 'talenthunt',
      script: 'server.js',
      env: { NODE_ENV: 'production', TRUST_PROXY: 'true', PORT: 4100 },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
