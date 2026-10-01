const crypto = require('crypto');
const config = require('./config');

/**
 * Sign a payload using HMAC-SHA256.
 * @param {object|string} payload - Event payload (object or raw string)
 * @param {string} [secret] - Secret key (defaults to config.WEBHOOK_SECRET)
 * @returns {string} Hex-encoded HMAC-SHA256 signature
 */
function signPayload(payload, secret = config.WEBHOOK_SECRET) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('hex');
}

/**
 * Verify an HMAC-SHA256 signature.
 * @param {object|string} payload - Event payload
 * @param {string} signatureHeader - Signature from X-Webhook-Signature header
 * @param {string} [secret] - Secret key (defaults to config.WEBHOOK_SECRET)
 * @returns {boolean} True if signature is valid
 */
function verifySignature(payload, signatureHeader, secret = config.WEBHOOK_SECRET) {
  if (!signatureHeader) return false;
  const expectedSignature = signPayload(payload, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch (err) {
    return false;
  }
}

module.exports = {
  signPayload,
  verifySignature
};
