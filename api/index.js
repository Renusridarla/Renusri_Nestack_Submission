const app = require('../src/app');
const db = require('../src/db');
const config = require('../src/config');

let isDbInitialized = false;

module.exports = async (req, res) => {
  if (!isDbInitialized) {
    await db.initDb(config.DB_PATH);
    isDbInitialized = true;
  }
  return app(req, res);
};
