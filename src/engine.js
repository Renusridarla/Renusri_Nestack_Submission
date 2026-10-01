const db = require('./db');
const crypto = require('./crypto');
const config = require('./config');

class WebhookDeliveryEngine {
  constructor() {
    this.inFlight = new Set();
    this.timer = null;
    this.isRunning = false;
  }

  /**
   * Start the background delivery engine worker
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Delivery Engine] Background worker started.');
    
    // Poll loop
    this.timer = setInterval(() => {
      this.tick();
    }, config.POLL_INTERVAL_MS);

    // Initial immediate tick on startup
    this.tick();
  }

  /**
   * Stop the background delivery engine worker
   */
  stop() {
    if (!this.isRunning) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[Delivery Engine] Background worker stopped.');
  }

  /**
   * Tick handler: finds due events and processes them
   */
  async tick() {
    if (!this.isRunning) return;

    try {
      const dueEvents = await db.getDueEvents();
      for (const eventRow of dueEvents) {
        if (!this.inFlight.has(eventRow.id)) {
          // Process event asynchronously without blocking the tick loop
          this.processEvent(eventRow).catch(err => {
            console.error(`[Delivery Engine] Error processing event ${eventRow.id}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[Delivery Engine] Error querying due events:', err.message);
    }
  }

  /**
   * Trigger immediate processing for a specific event ID (e.g. upon ingestion or manual retry)
   * @param {string} eventId 
   */
  async triggerImmediate(eventId) {
    try {
      const eventRow = await db.getEventById(eventId);
      if (eventRow && !this.inFlight.has(eventId)) {
        // Query low-level record to get retry_count and next_retry_at
        const database = db.getDb();
        database.get('SELECT * FROM events WHERE id = ?', [eventId], (err, row) => {
          if (!err && row && (row.status === 'pending' || row.status === 'failed')) {
            this.processEvent(row).catch(e => {
              console.error(`[Delivery Engine] Error in immediate delivery for ${eventId}:`, e.message);
            });
          }
        });
      }
    } catch (err) {
      console.error(`[Delivery Engine] Failed to trigger immediate delivery for ${eventId}:`, err.message);
    }
  }

  /**
   * Attempt delivery of a single event
   * @param {object} eventRow 
   */
  async processEvent(eventRow) {
    const eventId = eventRow.id;
    if (this.inFlight.has(eventId)) return;
    
    this.inFlight.add(eventId);

    const attemptedAt = new Date().toISOString();
    let httpStatus = null;
    let isSuccess = false;

    try {
      // Parse payload for HMAC signature calculation
      let payloadObj;
      try {
        payloadObj = JSON.parse(eventRow.payload);
      } catch (e) {
        payloadObj = eventRow.payload;
      }

      const signature = crypto.signPayload(payloadObj);
      const payloadString = typeof eventRow.payload === 'string' ? eventRow.payload : JSON.stringify(eventRow.payload);

      // Perform HTTP POST with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.HTTP_TIMEOUT_MS);

      try {
        const response = await fetch(eventRow.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature
          },
          body: payloadString,
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        httpStatus = response.status;
        isSuccess = response.ok; // 2xx status code
      } catch (reqError) {
        clearTimeout(timeoutId);
        // Connection error, timeout, DNS failure, etc.
        httpStatus = null;
        isSuccess = false;
      }

      // Record the attempt log in DB
      const outcome = isSuccess ? 'success' : 'failed';
      await db.recordAttempt(eventId, attemptedAt, httpStatus, outcome);

      if (isSuccess) {
        // Successful delivery! Update status to 'delivered'
        await db.updateEventStatus(eventId, 'delivered', null, eventRow.retry_count);
        console.log(`[Delivery Engine] Event ${eventId} DELIVERED successfully (HTTP ${httpStatus}).`);
      } else {
        // Delivery failed! Schedule retry or mark dead
        const currentRetryCount = eventRow.retry_count || 0; // retries done so far before this failed attempt
        // If currentRetryCount < MAX_RETRIES (3), schedule next retry
        if (currentRetryCount < config.MAX_RETRIES) {
          const delaySeconds = config.RETRY_INTERVALS_SECONDS[currentRetryCount];
          const nextRetryDate = new Date(Date.now() + delaySeconds * 1000).toISOString();
          const nextRetryCount = currentRetryCount + 1;

          await db.updateEventStatus(eventId, 'failed', nextRetryDate, nextRetryCount);
          console.log(`[Delivery Engine] Event ${eventId} FAILED attempt (HTTP ${httpStatus}). Scheduled retry #${nextRetryCount} in ${delaySeconds}s at ${nextRetryDate}.`);
        } else {
          // Reached max retries (3 retries failed -> 4 total attempts failed) -> Mark as 'dead'
          await db.updateEventStatus(eventId, 'dead', null, currentRetryCount + 1);
          console.log(`[Delivery Engine] Event ${eventId} DEAD after ${currentRetryCount + 1} total failed attempts.`);
        }
      }
    } catch (err) {
      console.error(`[Delivery Engine] Fatal error during processEvent for ${eventId}:`, err.message);
    } finally {
      this.inFlight.delete(eventId);
    }
  }
}

// Singleton instance
const engine = new WebhookDeliveryEngine();

module.exports = engine;
