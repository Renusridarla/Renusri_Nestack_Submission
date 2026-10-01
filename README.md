# Webhook Delivery Engine

> **Nestack SDE Technical Assessment** — A resilient, production-ready custom Webhook Delivery Engine built in Node.js & SQLite with zero external queue libraries. Features automatic retries with custom interval scheduling, HMAC-SHA256 signature verification, status visibility APIs, and manual dead-event recovery.

🌐 **Live Deployment Link:** [https://internship-olive-xi.vercel.app](https://internship-olive-xi.vercel.app)

---

## 📋 Table of Contents
- [Overview & Key Features](#-overview--key-features)
- [Live Deployment Link](#-live-deployment-link)
- [Architecture & Design](#-architecture--design)
- [Delivery Rules & Retry Schedule](#-delivery-rules--retry-schedule)
- [Server Restart Behavior](#-server-restart-behavior)
- [HMAC SHA-256 Signature Verification](#-hmac-sha-256-signature-verification)
- [API Endpoints Reference](#-api-endpoints-reference)
- [Getting Started & Installation](#-getting-started--installation)
- [Running Tests](#-running-tests)
- [Evaluation & Submission Info](#-evaluation--submission-info)

---

## 🌐 Live Deployment Link

The Webhook Delivery Engine is deployed live on Vercel:

- **Base URL:** `https://internship-olive-xi.vercel.app`
- **List Events:** `GET https://internship-olive-xi.vercel.app/events`
- **Ingest Event:** `POST https://internship-olive-xi.vercel.app/events`
- **Cron Tick Endpoint:** `GET https://internship-olive-xi.vercel.app/api/cron`

---

## 🚀 Overview & Key Features

Modern SaaS platforms require dependable webhook delivery for event notifications (e.g. `payment.failed`, `user.signup`). This Webhook Delivery Engine receives incoming events, immediately attempts HTTP POST delivery to customer endpoints, handles failures gracefully with exponential backoff retries, and provides full status inspection APIs.

### Key Features
- **Zero External Queue Libraries**: Built completely from scratch without Celery, BullMQ, RQ, Bull, or Bee-Queue. Retry scheduling is managed directly via an internal polling worker and SQLite database timestamps.
- **Immediate Ingestion Attempt**: Delivers webhooks immediately upon ingestion without waiting for the first retry interval.
- **Strict Retry Schedule**: Automatically retries failed deliveries using the exact required schedule: **30 seconds** $\rightarrow$ **5 minutes** $\rightarrow$ **30 minutes**.
- **Dead Event Management**: Automatically marks events as `dead` after 4 total failed attempts (1 initial + 3 retries). Provides a dedicated endpoint to manually trigger a retry.
- **HMAC-SHA256 Signatures**: Every outgoing HTTP POST request includes an `X-Webhook-Signature` header computed over the payload.
- **Persistent Storage & Crash Resilience**: Uses SQLite storage. In-progress retries and schedules survive server restarts seamlessly.
- **Built-in Mock Testing Webhooks**: Includes test endpoints (`/test-webhook/success`, `/test-webhook/fail`, `/test-webhook/timeout`, `/test-webhook/verify`) to simplify local testing and evaluation.

---

## 🏗 Architecture & Design

The system runs as a unified service hosting both the API Web Server and the Background Delivery Worker:

```
                  +-----------------------------------+
                  |        Incoming API Request       |
                  +-----------------------------------+
                                    |
                                    v
                          [ POST /events ]
                                    |
                                    v
                       +-------------------------+
                       |  Save Event to SQLite   |
                       | (status: pending, now)  |
                       +-------------------------+
                                    |
          +-------------------------+-------------------------+
          | (Immediate trigger)                               | (Background Worker Tick / Cron)
          v                                                   v
+---------------------------------------------------------------------------------+
|                            Webhook Delivery Engine                              |
| 1. Compute HMAC-SHA256 signature -> Set X-Webhook-Signature header             |
| 2. Perform HTTP POST request (5s timeout)                                       |
+---------------------------------------------------------------------------------+
          |                                                   |
          v (HTTP 2xx Success)                                v (Non-2xx / Timeout / Error)
+------------------------------------+             +------------------------------------+
|  Set status = 'delivered'          |             | Log failed attempt                 |
|  Log attempt outcome               |             | If retries < 3:                    |
+------------------------------------+             |   Set status = 'failed'            |
                                                   |   Set next_retry_at = now + delay  |
                                                   | If retries == 3 (4th failure):     |
                                                   |   Set status = 'dead'              |
                                                   +------------------------------------+
```

### Core Components
1. **`src/app.js`**: Express server setup, middleware, and CORS configuration.
2. **`src/db.js`**: SQLite persistence layer managing `events` and `attempts` schema and queries.
3. **`src/engine.js`**: Custom Webhook Delivery Worker with immediate dispatch, non-blocking polling tick, and in-flight concurrency lock.
4. **`src/crypto.js`**: HMAC-SHA256 signature generator and verification module.
5. **`src/routes.js`**: REST endpoints for event ingestion, listing, detail lookup, manual dead event retries, and mock webhooks.

---

## ⏱ Delivery Rules & Retry Schedule

- **Initial Attempt**: Executed immediately as soon as the event is ingested (`POST /events`).
- **Failure Conditions**:
  - Any Non-2xx HTTP response status (e.g. 400, 404, 500, 502, 503).
  - Connection timeout (exceeding 5000 ms).
  - Network errors (e.g. `ECONNREFUSED`, DNS resolution failure).
- **Fixed Retry Intervals**:
  - **Retry 1** (Attempt 2): **30 seconds** after initial failure.
  - **Retry 2** (Attempt 3): **5 minutes** (300 s) after 1st retry failure.
  - **Retry 3** (Attempt 4): **30 minutes** (1800 s) after 2nd retry failure.
- **Dead Status**: If all 3 retries (4 total attempts) fail, the event status transitions to `dead` and automatic retries stop.
- **Success Condition**: A 2xx HTTP response at any attempt immediately sets `status` to `delivered`.

---

## 🔄 Server Restart Behavior

### *How a server restart affects in-progress retries — and how our implementation handles it:*

Our implementation **fully handles server restarts without losing or corrupting retry schedules**:

1. **State Persistence**: All event metadata, attempt logs, current retry counts (`retry_count`), and exact target timestamps (`next_retry_at`) are stored durably in the SQLite database (`webhook_engine.db`).
2. **Seamless Recovery on Startup**:
   - When the server restarts, the background worker initializes and immediately queries SQLite for events matching:
     ```sql
     SELECT * FROM events 
     WHERE status IN ('pending', 'failed') 
       AND next_retry_at IS NOT NULL 
       AND next_retry_at <= CURRENT_TIMESTAMP 
       AND retry_count < 4
     ```
   - **Overdue Retries**: Any retry that was scheduled to fire while the server was offline will be picked up and attempted **immediately upon server startup**.
   - **Future Scheduled Retries**: Any retry scheduled for a future time will be picked up naturally when `next_retry_at` is reached.
3. **No Duplicate Processing**: The delivery engine maintains an in-memory set of currently processing event IDs (`inFlight`) to guarantee that concurrent worker ticks never trigger duplicate simultaneous HTTP attempts for the same event.

---

## 🔐 HMAC SHA-256 Signature Verification

Every outgoing webhook request signed by the engine contains the hex-encoded HMAC-SHA256 signature in the `X-Webhook-Signature` header.

- **Secret Key**: Configurable via the `WEBHOOK_SECRET` environment variable (Default: `whsec_nestack_secret_key_2026`).
- **Signature Calculation**: HMAC-SHA256 digest calculated over the JSON payload body string:
  $$\text{Signature} = \text{HMAC-SHA256}(\text{payload\_json\_string}, \text{secret\_key})$$

### Code Verification Examples

#### JavaScript / Node.js Verification:
```javascript
const crypto = require('crypto');

function verifyWebhook(payloadObject, signatureHeader, secretKey) {
  const payloadString = JSON.stringify(payloadObject);
  const expectedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(payloadString)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}
```

#### Python Verification:
```python
import hmac, hashlib, json

def verify_webhook(payload_dict, signature_header, secret_key):
    payload_string = json.dumps(payload_dict, separators=(',', ':')) # or raw request body
    expected_signature = hmac.new(
        secret_key.encode('utf-8'),
        payload_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected_signature, signature_header)
```

---

## 📖 API Endpoints Reference

### 1. Ingest Event
`POST /events`

**Request Body:**
```json
{
  "type": "payment.failed",
  "payload": {
    "order_id": "ord_9948",
    "amount": 2500,
    "currency": "INR"
  },
  "webhook_url": "https://internship-olive-xi.vercel.app/test-webhook/success"
}
```

**Response (201 Created):**
```json
{
  "id": "evt_8f3d1a9b-1234-4567-89ab-cdef01234567",
  "type": "payment.failed",
  "payload": {
    "order_id": "ord_9948",
    "amount": 2500,
    "currency": "INR"
  },
  "webhook_url": "https://internship-olive-xi.vercel.app/test-webhook/success",
  "status": "pending",
  "created_at": "2026-10-01T17:45:00.000Z",
  "attempts": []
}
```

---

### 2. List All Events
`GET /events`

**Response (200 OK):**
```json
[
  {
    "id": "evt_8f3d1a9b-1234-4567-89ab-cdef01234567",
    "type": "payment.failed",
    "payload": { "order_id": "ord_9948" },
    "webhook_url": "https://internship-olive-xi.vercel.app/test-webhook/success",
    "status": "delivered",
    "created_at": "2026-10-01T17:45:00.000Z",
    "attempts": [
      {
        "attempted_at": "2026-10-01T17:45:00.120Z",
        "http_status": 200,
        "outcome": "success"
      }
    ]
  }
]
```

---

### 3. Get Event Details & Attempt History
`GET /events/:id`

**Response (200 OK):**
```json
{
  "id": "evt_8f3d1a9b-1234-4567-89ab-cdef01234567",
  "type": "user.signup",
  "payload": { "user_id": 42 },
  "webhook_url": "https://internship-olive-xi.vercel.app/test-webhook/fail",
  "status": "failed",
  "created_at": "2026-10-01T17:45:00.000Z",
  "attempts": [
    {
      "attempted_at": "2026-10-01T17:45:00.120Z",
      "http_status": 500,
      "outcome": "failed"
    }
  ]
}
```

---

### 4. Manually Retry a Dead Event
`POST /events/:id/retry`

- Returns `200 OK` with re-queued event object if status was `dead`.
- Returns `400 Bad Request` if status is not `dead`.

---

## 💻 Getting Started & Installation

### Prerequisites
- Node.js (v18.0.0 or higher)
- npm (v9.0.0 or higher)

### Setup & Run Instructions

1. **Clone or extract repository**:
   ```bash
   git clone https://github.com/Renusridarla/Renusri_Nestack_Submission.git
   cd Renusri_Nestack_Submission
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the API Server and Delivery Engine Worker**:
   ```bash
   npm start
   ```

---

## 🧪 Running Tests

```bash
npm test
```

---

## 📌 Evaluation & Submission Info

- **GitHub Repository**: [https://github.com/Renusridarla/Renusri_Nestack_Submission](https://github.com/Renusridarla/Renusri_Nestack_Submission)
- **Live Deployment Link**: [https://internship-olive-xi.vercel.app](https://internship-olive-xi.vercel.app)
- **Required Evaluator Contributors**:
  - `bishal@nestack.com`
  - `sannidhya@nestack.com`
  - `sanjay@nestack.com`
- **Submission Artifacts**:
  - Complete Codebase ZIP File: `Renusri_Nestack_Submission.zip`
