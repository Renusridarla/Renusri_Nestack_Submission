const express = require('express');
const router = express.Router();
const db = require('./db');
const engine = require('./engine');
const crypto = require('./crypto');
const config = require('./config');

/**
 * POST /events
 * Ingest an incoming event and queue it for delivery
 */
router.post('/events', async (req, res) => {
  try {
    const { type, payload, webhook_url } = req.body;

    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "type" field in request body.' });
    }

    if (payload === undefined || payload === null || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid "payload" field. Must be a JSON object.' });
    }

    if (!webhook_url || typeof webhook_url !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "webhook_url" field.' });
    }

    try {
      const parsedUrl = new URL(webhook_url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return res.status(400).json({ error: 'webhook_url must use http or https protocol.' });
      }
    } catch (urlErr) {
      return res.status(400).json({ error: 'Invalid webhook_url format.' });
    }

    // Create event in database
    const event = await db.createEvent({ type, payload, webhook_url });

    // Trigger immediate delivery attempt asynchronously
    setImmediate(async () => {
      try {
        const database = db.getDb();
        database.get('SELECT * FROM events WHERE id = ?', [event.id], async (err, row) => {
          if (!err && row && (row.status === 'pending' || row.status === 'failed')) {
            await engine.processEvent(row);
          }
        });
      } catch (e) {
        // Ignore async delivery errors during teardown
      }
    });

    return res.status(201).json(event);
  } catch (err) {
    console.error('Error creating event:', err);
    return res.status(500).json({ error: 'Internal server error while ingesting event.' });
  }
});

/**
 * GET /events
 * List all events
 */
router.get('/events', async (req, res) => {
  try {
    const events = await db.getAllEvents();
    return res.status(200).json(events);
  } catch (err) {
    console.error('Error listing events:', err);
    return res.status(500).json({ error: 'Internal server error while fetching events.' });
  }
});

/**
 * GET /events/:id
 * Retrieve a single event with full attempt history
 */
router.get('/events/:id', async (req, res) => {
  try {
    const event = await db.getEventById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: `Event with ID "${req.params.id}" not found.` });
    }
    return res.status(200).json(event);
  } catch (err) {
    console.error(`Error retrieving event ${req.params.id}:`, err);
    return res.status(500).json({ error: 'Internal server error while fetching event.' });
  }
});

/**
 * POST /events/:id/retry
 * Manually trigger a retry for a dead event
 */
router.post('/events/:id/retry', async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = await db.getEventById(eventId);

    if (!event) {
      return res.status(404).json({ error: `Event with ID "${eventId}" not found.` });
    }

    if (event.status !== 'dead') {
      return res.status(400).json({
        error: `Cannot retry event "${eventId}". Only dead events can be manually retried.`,
        current_status: event.status
      });
    }

    // Reset dead event to pending
    const resetSuccess = await db.resetEventForRetry(eventId);
    if (!resetSuccess) {
      return res.status(400).json({ error: 'Failed to re-queue event for retry.' });
    }

    // Trigger immediate attempt
    setImmediate(async () => {
      try {
        const database = db.getDb();
        database.get('SELECT * FROM events WHERE id = ?', [eventId], async (err, row) => {
          if (!err && row && (row.status === 'pending' || row.status === 'failed')) {
            await engine.processEvent(row);
          }
        });
      } catch (e) {
        // Ignore async errors
      }
    });

    const updatedEvent = await db.getEventById(eventId);
    return res.status(200).json(updatedEvent);
  } catch (err) {
    console.error(`Error retrying event ${req.params.id}:`, err);
    return res.status(500).json({ error: 'Internal server error while retrying event.' });
  }
});

/**
 * GET /cron or GET /api/cron
 * Trigger scheduled retries tick (Vercel Cron compatible)
 */
router.get(['/cron', '/api/cron'], async (req, res) => {
  try {
    const dueEvents = await db.getDueEvents();
    let processedCount = 0;
    for (const eventRow of dueEvents) {
      await engine.processEvent(eventRow);
      processedCount++;
    }
    return res.status(200).json({
      message: 'Cron tick executed successfully',
      processed_events: processedCount,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error executing cron tick:', err);
    return res.status(500).json({ error: 'Failed to execute cron tick.' });
  }
});

// ==========================================
// MOCK WEBHOOK TEST ENDPOINTS (FOR EVALUATION)
// ==========================================

/**
 * POST /test-webhook/success
 * Mock endpoint that simulates successful webhook delivery (HTTP 200)
 */
router.post('/test-webhook/success', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const isValidSignature = crypto.verifySignature(req.body, signature, config.WEBHOOK_SECRET);

  return res.status(200).json({
    message: 'Mock webhook received successfully',
    signature_valid: isValidSignature,
    received_at: new Date().toISOString(),
    payload: req.body
  });
});

/**
 * POST /test-webhook/fail
 * Mock endpoint that simulates webhook delivery failure (HTTP 500)
 */
router.post('/test-webhook/fail', (req, res) => {
  return res.status(500).json({
    error: 'Simulated endpoint failure',
    received_at: new Date().toISOString()
  });
});

/**
 * POST /test-webhook/timeout
 * Mock endpoint that simulates a request timeout (delays 10s > 5s timeout)
 */
router.post('/test-webhook/timeout', (req, res) => {
  setTimeout(() => {
    return res.status(200).json({ message: 'Delayed response' });
  }, 10000);
});

/**
 * POST /test-webhook/verify
 * Helper endpoint to test HMAC signature verification
 */
router.post('/test-webhook/verify', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const isValid = crypto.verifySignature(req.body, signature, config.WEBHOOK_SECRET);
  return res.status(200).json({
    valid: isValid,
    signature_header: signature || null
  });
});

module.exports = router;
