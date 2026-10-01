require('dotenv').config();

const isVercel = process.env.VERCEL === '1';

module.exports = {
  PORT: process.env.PORT || 3000,
  DB_PATH: process.env.DB_PATH || (isVercel ? '/tmp/webhook_engine.db' : './webhook_engine.db'),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'whsec_nestack_secret_key_2026',
  
  // Retry intervals in seconds: 30s -> 5m (300s) -> 30m (1800s)
  RETRY_INTERVALS_SECONDS: [30, 300, 1800],
  
  // Maximum number of retries (Total total attempts = 1 initial + 3 retries = 4 attempts)
  MAX_RETRIES: 3,
  
  // HTTP Timeout for outgoing webhook requests in milliseconds (5 seconds)
  HTTP_TIMEOUT_MS: parseInt(process.env.HTTP_TIMEOUT_MS || '5000', 10),
  
  // Worker background polling interval in milliseconds (1 second)
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '1000', 10),

  IS_VERCEL: isVercel
};
