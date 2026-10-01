const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const config = require('./config');

let db = null;
let pgPool = null;
let isPg = false;

/**
 * Helper to convert SQL query with ? placeholders into $1, $2, ... for PostgreSQL
 */
function prepareSql(sql) {
  if (!isPg) return sql;
  let count = 0;
  return sql.replace(/\?/g, () => `$${++count}`);
}

/**
 * Execute a SQL query (works seamlessly across SQLite and PostgreSQL)
 */
function query(sql, params = []) {
  if (isPg) {
    const formattedSql = prepareSql(sql);
    return pgPool.query(formattedSql, params).then(res => res.rows);
  } else {
    return new Promise((resolve, reject) => {
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT')) {
        db.all(sql, params, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      } else {
        db.run(sql, params, function(err) {
          if (err) return reject(err);
          resolve({ lastID: this.lastID, changes: this.changes, rowCount: this.changes });
        });
      }
    });
  }
}

/**
 * Initialize Database connection (PostgreSQL if DATABASE_URL is set, otherwise SQLite)
 */
async function initDb(dbPath = config.DB_PATH) {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (connectionString && (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://'))) {
    isPg = true;
    console.log('[Database] Connecting to PostgreSQL database...');
    pgPool = new Pool({
      connectionString: connectionString,
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
    });

    // Test connection
    await pgPool.query('SELECT 1');

    // Create events table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(255) NOT NULL,
        payload TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at VARCHAR(100) NOT NULL,
        next_retry_at VARCHAR(100),
        retry_count INT NOT NULL DEFAULT 0
      )
    `);

    // Create attempts table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS attempts (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        attempted_at VARCHAR(100) NOT NULL,
        http_status INT,
        outcome VARCHAR(50) NOT NULL
      )
    `);

    console.log('[Database] PostgreSQL tables initialized.');
    return pgPool;
  } else {
    isPg = false;
    return new Promise((resolve, reject) => {
      db = new sqlite3.Database(dbPath, (err) => {
        if (err) return reject(err);

        db.run('PRAGMA foreign_keys = ON;', (fkErr) => {
          if (fkErr) return reject(fkErr);

          db.serialize(() => {
            db.run(`
              CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                payload TEXT NOT NULL,
                webhook_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                next_retry_at TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0
              )
            `);

            db.run(`
              CREATE TABLE IF NOT EXISTS attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL,
                attempted_at TEXT NOT NULL,
                http_status INTEGER,
                outcome TEXT NOT NULL,
                FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE
              )
            `, (tableErr) => {
              if (tableErr) return reject(tableErr);
              resolve(db);
            });
          });
        });
      });
    });
  }
}

/**
 * Get active database instance
 */
function getDb() {
  if (!db && !pgPool) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return isPg ? pgPool : db;
}

/**
 * Create a new event
 */
async function createEvent({ type, payload, webhook_url }) {
  const id = 'evt_' + (require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now() + Math.random().toString(36).substring(2, 9));
  const now = new Date().toISOString();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const sql = `
    INSERT INTO events (id, type, payload, webhook_url, status, created_at, next_retry_at, retry_count)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)
  `;

  await query(sql, [id, type, payloadStr, webhook_url, now, now]);
  return getEventById(id);
}

/**
 * Get event by ID with its attempts list
 */
async function getEventById(id) {
  const eventRows = await query('SELECT * FROM events WHERE id = ?', [id]);
  if (!eventRows || eventRows.length === 0) return null;

  const eventRow = eventRows[0];
  const attemptRows = await query(
    'SELECT attempted_at, http_status, outcome FROM attempts WHERE event_id = ? ORDER BY id ASC',
    [id]
  );

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(eventRow.payload);
  } catch (e) {
    parsedPayload = eventRow.payload;
  }

  const attempts = (attemptRows || []).map(row => ({
    attempted_at: row.attempted_at,
    http_status: row.http_status,
    outcome: row.outcome
  }));

  return {
    id: eventRow.id,
    type: eventRow.type,
    payload: parsedPayload,
    webhook_url: eventRow.webhook_url,
    status: eventRow.status,
    created_at: eventRow.created_at,
    attempts: attempts
  };
}

/**
 * Get all events with their attempts
 */
async function getAllEvents() {
  const rows = await query('SELECT id FROM events ORDER BY created_at DESC', []);
  if (!rows || rows.length === 0) return [];
  return Promise.all(rows.map(row => getEventById(row.id)));
}

/**
 * Get pending/failed events due for delivery
 */
async function getDueEvents() {
  const nowIso = new Date().toISOString();
  const sql = `
    SELECT * FROM events 
    WHERE status IN ('pending', 'failed') 
      AND next_retry_at IS NOT NULL 
      AND next_retry_at <= ? 
      AND retry_count < 4
    ORDER BY created_at ASC
  `;
  return query(sql, [nowIso]);
}

/**
 * Record a delivery attempt
 */
async function recordAttempt(eventId, attemptedAt, httpStatus, outcome) {
  const sql = `
    INSERT INTO attempts (event_id, attempted_at, http_status, outcome)
    VALUES (?, ?, ?, ?)
  `;
  const result = await query(sql, [eventId, attemptedAt, httpStatus, outcome]);
  return result ? result.lastID : null;
}

/**
 * Update event status and scheduling details
 */
async function updateEventStatus(eventId, status, nextRetryAt, retryCount) {
  const sql = `
    UPDATE events 
    SET status = ?, next_retry_at = ?, retry_count = ?
    WHERE id = ?
  `;
  const result = await query(sql, [status, nextRetryAt, retryCount, eventId]);
  return result ? (result.changes || result.rowCount) : 0;
}

/**
 * Reset a dead event for manual retry
 */
async function resetEventForRetry(eventId) {
  const nowIso = new Date().toISOString();
  const sql = `
    UPDATE events 
    SET status = 'pending', next_retry_at = ?, retry_count = 0 
    WHERE id = ? AND status = 'dead'
  `;
  const result = await query(sql, [nowIso, eventId]);
  const affected = result ? (result.changes || result.rowCount) : 0;
  return affected > 0;
}

/**
 * Close database connection
 */
async function closeDb() {
  if (isPg && pgPool) {
    await pgPool.end();
    pgPool = null;
  } else if (db) {
    await new Promise(r => db.close(r));
    db = null;
  }
}

module.exports = {
  initDb,
  getDb,
  query,
  createEvent,
  getEventById,
  getAllEvents,
  getDueEvents,
  recordAttempt,
  updateEventStatus,
  resetEventForRetry,
  closeDb
};
