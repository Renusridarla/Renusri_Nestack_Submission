const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('crypto'); // Built-in crypto.randomUUID or uuid fallback
const config = require('./config');

let db = null;

/**
 * Initialize SQLite Database connection and create tables
 * @param {string} [dbPath] - Database file path or ':memory:'
 * @returns {Promise<sqlite3.Database>}
 */
function initDb(dbPath = config.DB_PATH) {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        return reject(err);
      }
      
      db.run('PRAGMA foreign_keys = ON;', (fkErr) => {
        if (fkErr) return reject(fkErr);

        db.serialize(() => {
          // Create events table
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

          // Create attempts table
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

/**
 * Get active database instance
 */
function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Create a new event
 */
function createEvent({ type, payload, webhook_url }) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const id = 'evt_' + (require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now() + Math.random().toString(36).substring(2, 9));
    const now = new Date().toISOString();
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    
    // Status is pending, next_retry_at is set to now for immediate first attempt
    const query = `
      INSERT INTO events (id, type, payload, webhook_url, status, created_at, next_retry_at, retry_count)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)
    `;

    database.run(query, [id, type, payloadStr, webhook_url, now, now], function(err) {
      if (err) return reject(err);
      getEventById(id).then(resolve).catch(reject);
    });
  });
}

/**
 * Get event by ID with its attempts list
 */
function getEventById(id) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    
    database.get('SELECT * FROM events WHERE id = ?', [id], (err, eventRow) => {
      if (err) return reject(err);
      if (!eventRow) return resolve(null);

      database.all(
        'SELECT attempted_at, http_status, outcome FROM attempts WHERE event_id = ? ORDER BY id ASC',
        [id],
        (attemptErr, attemptRows) => {
          if (attemptErr) return reject(attemptErr);

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

          resolve({
            id: eventRow.id,
            type: eventRow.type,
            payload: parsedPayload,
            webhook_url: eventRow.webhook_url,
            status: eventRow.status,
            created_at: eventRow.created_at,
            attempts: attempts
          });
        }
      );
    });
  });
}

/**
 * Get all events with their attempts
 */
function getAllEvents() {
  return new Promise((resolve, reject) => {
    const database = getDb();

    database.all('SELECT id FROM events ORDER BY created_at DESC', [], async (err, rows) => {
      if (err) return reject(err);
      if (!rows || rows.length === 0) return resolve([]);

      try {
        const events = await Promise.all(rows.map(row => getEventById(row.id)));
        resolve(events);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Get pending/failed events due for delivery
 */
function getDueEvents() {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const nowIso = new Date().toISOString();

    const query = `
      SELECT * FROM events 
      WHERE status IN ('pending', 'failed') 
        AND next_retry_at IS NOT NULL 
        AND next_retry_at <= ? 
        AND retry_count < 4
      ORDER BY created_at ASC
    `;

    database.all(query, [nowIso], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/**
 * Record a delivery attempt
 */
function recordAttempt(eventId, attemptedAt, httpStatus, outcome) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const query = `
      INSERT INTO attempts (event_id, attempted_at, http_status, outcome)
      VALUES (?, ?, ?, ?)
    `;
    database.run(query, [eventId, attemptedAt, httpStatus, outcome], function(err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
  });
}

/**
 * Update event status and scheduling details
 */
function updateEventStatus(eventId, status, nextRetryAt, retryCount) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const query = `
      UPDATE events 
      SET status = ?, next_retry_at = ?, retry_count = ?
      WHERE id = ?
    `;
    database.run(query, [status, nextRetryAt, retryCount, eventId], function(err) {
      if (err) return reject(err);
      resolve(this.changes);
    });
  });
}

/**
 * Reset a dead event for manual retry
 */
function resetEventForRetry(eventId) {
  return new Promise((resolve, reject) => {
    const database = getDb();
    const nowIso = new Date().toISOString();

    // Reset status to pending, next_retry_at to now, and retry_count to 0 so fresh retry cycle starts
    const query = `
      UPDATE events 
      SET status = 'pending', next_retry_at = ?, retry_count = 0 
      WHERE id = ? AND status = 'dead'
    `;

    database.run(query, [nowIso, eventId], function(err) {
      if (err) return reject(err);
      if (this.changes === 0) return resolve(false);
      resolve(true);
    });
  });
}

/**
 * Close database connection
 */
function closeDb() {
  return new Promise((resolve) => {
    if (db) {
      db.close(() => {
        db = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  initDb,
  getDb,
  createEvent,
  getEventById,
  getAllEvents,
  getDueEvents,
  recordAttempt,
  updateEventStatus,
  resetEventForRetry,
  closeDb
};
