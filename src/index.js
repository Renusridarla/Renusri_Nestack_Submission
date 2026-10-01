const app = require('./app');
const db = require('./db');
const engine = require('./engine');
const config = require('./config');

async function startServer() {
  try {
    // 1. Initialize SQLite Database
    await db.initDb(config.DB_PATH);
    console.log(`[Database] SQLite connected at "${config.DB_PATH}".`);

    // 2. Start Delivery Engine Background Worker
    engine.start();

    // 3. Start Express HTTP Server
    const server = app.listen(config.PORT, () => {
      console.log(`[API Server] Webhook Delivery Engine running on port ${config.PORT}`);
      console.log(`[API Server] Endpoints available:`);
      console.log(`  - POST http://localhost:${config.PORT}/events`);
      console.log(`  - GET  http://localhost:${config.PORT}/events`);
      console.log(`  - GET  http://localhost:${config.PORT}/events/:id`);
      console.log(`  - POST http://localhost:${config.PORT}/events/:id/retry`);
    });

    // Graceful Shutdown
    const shutdown = async (signal) => {
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);
      engine.stop();
      server.close(async () => {
        await db.closeDb();
        console.log('Server and database connection closed.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

startServer();
