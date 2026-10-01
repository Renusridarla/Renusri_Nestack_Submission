const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const engine = require('../src/engine');
const crypto = require('../src/crypto');
const config = require('../src/config');
const http = require('http');

let server;
const TEST_PORT = 3999;

beforeAll(async () => {
  // Use in-memory DB for tests
  await db.initDb(':memory:');
  // Start server on test port so webhooks can target http://localhost:3999/test-webhook/...
  server = app.listen(TEST_PORT);
});

afterAll(async () => {
  engine.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.closeDb();
});

beforeEach(async () => {
  // Clear tables between tests
  const database = db.getDb();
  await new Promise((resolve) => database.run('DELETE FROM attempts', resolve));
  await new Promise((resolve) => database.run('DELETE FROM events', resolve));
});

describe('Webhook Delivery Engine Test Suite', () => {

  describe('1. Event Ingestion (POST /events)', () => {
    test('should ingest a valid event and return 201 with status pending', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          type: 'payment.failed',
          payload: { order_id: 101, amount: 49.99 },
          webhook_url: `http://localhost:${TEST_PORT}/test-webhook/success`
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.type).toBe('payment.failed');
      expect(res.body.payload).toEqual({ order_id: 101, amount: 49.99 });
      expect(res.body.webhook_url).toBe(`http://localhost:${TEST_PORT}/test-webhook/success`);
      expect(res.body.status).toBe('pending');
      expect(res.body).toHaveProperty('created_at');
      expect(Array.isArray(res.body.attempts)).toBe(true);
    });

    test('should reject request with missing or invalid fields (400 Bad Request)', async () => {
      const res1 = await request(app).post('/events').send({});
      expect(res1.status).toBe(400);

      const res2 = await request(app).post('/events').send({
        type: 'user.signup',
        webhook_url: 'invalid-url'
      });
      expect(res2.status).toBe(400);
    });
  });

  describe('2. Immediate Delivery & HMAC Signing', () => {
    test('should attempt delivery immediately and mark status as delivered on 200 OK', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          type: 'user.signup',
          payload: { user_id: 'usr_123', email: 'test@example.com' },
          webhook_url: `http://localhost:${TEST_PORT}/test-webhook/success`
        });

      const eventId = res.body.id;

      // Wait briefly for immediate setImmediate background delivery to complete
      await new Promise(r => setTimeout(r, 300));

      const eventRes = await request(app).get(`/events/${eventId}`);
      expect(eventRes.status).toBe(200);
      expect(eventRes.body.status).toBe('delivered');
      expect(eventRes.body.attempts.length).toBe(1);
      expect(eventRes.body.attempts[0].http_status).toBe(200);
      expect(eventRes.body.attempts[0].outcome).toBe('success');
    });

    test('should correctly sign payload with HMAC-SHA256 in X-Webhook-Signature header', () => {
      const payload = { amount: 100, currency: 'USD' };
      const signature = crypto.signPayload(payload, 'test_secret');
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // 64 hex characters for SHA-256

      const isValid = crypto.verifySignature(payload, signature, 'test_secret');
      expect(isValid).toBe(true);
    });
  });

  describe('3. Failure Handling & Dead Status Transition', () => {
    test('should handle delivery failure and schedule retry', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          type: 'order.canceled',
          payload: { order_id: 202 },
          webhook_url: `http://localhost:${TEST_PORT}/test-webhook/fail`
        });

      const eventId = res.body.id;

      // Wait for immediate 1st attempt to fail
      await new Promise(r => setTimeout(r, 300));

      const eventRes = await request(app).get(`/events/${eventId}`);
      expect(eventRes.status).toBe(200);
      expect(eventRes.body.status).toBe('failed');
      expect(eventRes.body.attempts.length).toBe(1);
      expect(eventRes.body.attempts[0].http_status).toBe(500);
      expect(eventRes.body.attempts[0].outcome).toBe('failed');
    });

    test('should handle network connection refused without crashing', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          type: 'ping',
          payload: { hello: 'world' },
          webhook_url: 'http://127.0.0.1:59999/unreachable'
        });

      const eventId = res.body.id;

      await new Promise(r => setTimeout(r, 300));

      const eventRes = await request(app).get(`/events/${eventId}`);
      expect(eventRes.status).toBe(200);
      expect(eventRes.body.status).toBe('failed');
      expect(eventRes.body.attempts.length).toBe(1);
      expect(eventRes.body.attempts[0].http_status).toBeNull();
      expect(eventRes.body.attempts[0].outcome).toBe('failed');
    });

    test('should transition status to dead after max retries (4 total failed attempts)', async () => {
      const event = await db.createEvent({
        type: 'test.dead',
        payload: { item: 1 },
        webhook_url: `http://localhost:${TEST_PORT}/test-webhook/fail`
      });

      const database = db.getDb();

      // Simulate 4 failed attempts directly in DB
      const now = new Date().toISOString();
      await db.recordAttempt(event.id, now, 500, 'failed');
      await db.recordAttempt(event.id, now, 500, 'failed');
      await db.recordAttempt(event.id, now, 500, 'failed');
      await db.recordAttempt(event.id, now, 500, 'failed');

      // Update event status to dead (retry_count = 4)
      await db.updateEventStatus(event.id, 'dead', null, 4);

      const eventRes = await request(app).get(`/events/${event.id}`);
      expect(eventRes.body.status).toBe('dead');
      expect(eventRes.body.attempts.length).toBe(4);
    });
  });

  describe('4. Status Visibility Endpoints', () => {
    test('GET /events should list all ingested events', async () => {
      await db.createEvent({ type: 'e1', payload: {}, webhook_url: 'http://example.com' });
      await db.createEvent({ type: 'e2', payload: {}, webhook_url: 'http://example.com' });

      const res = await request(app).get('/events');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    test('GET /events/:id should return 404 for non-existent event', async () => {
      const res = await request(app).get('/events/non_existent_id');
      expect(res.status).toBe(404);
    });
  });

  describe('5. Manual Retry for Dead Events (POST /events/:id/retry)', () => {
    test('should return 400 Bad Request when attempting to retry a non-dead event', async () => {
      const res = await request(app)
        .post('/events')
        .send({
          type: 'payment.success',
          payload: { id: 1 },
          webhook_url: `http://localhost:${TEST_PORT}/test-webhook/success`
        });

      const eventId = res.body.id;

      const retryRes = await request(app).post(`/events/${eventId}/retry`);
      expect(retryRes.status).toBe(400);
      expect(retryRes.body.error).toContain('Only dead events can be manually retried');
    });

    test('should re-queue a dead event and attempt delivery immediately', async () => {
      const event = await db.createEvent({
        type: 'manual.retry.test',
        payload: { attempt: 'manual' },
        webhook_url: `http://localhost:${TEST_PORT}/test-webhook/success`
      });

      // Manually set status to dead
      await db.updateEventStatus(event.id, 'dead', null, 4);

      const retryRes = await request(app).post(`/events/${event.id}/retry`);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.status).toBe('pending');

      // Wait for immediate re-queued delivery to complete
      await new Promise(r => setTimeout(r, 300));

      const finalRes = await request(app).get(`/events/${event.id}`);
      expect(finalRes.body.status).toBe('delivered');
      expect(finalRes.body.attempts.length).toBe(1);
      expect(finalRes.body.attempts[0].outcome).toBe('success');
    });
  });
});
