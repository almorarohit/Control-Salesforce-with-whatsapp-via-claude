import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Meta signs the raw request body with the App Secret: `X-Hub-Signature-256: sha256=<hex>`.
// Must be computed over the exact bytes received, never re-serialized JSON.
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Constant-time string comparison (hashing first makes lengths equal).
export function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(h(a), h(b));
}

// GET /webhook subscription handshake.
export function handleVerify(params, verifyToken) {
  const ok = params.get('hub.mode') === 'subscribe' && verifyToken && safeEqual(params.get('hub.verify_token'), verifyToken);
  return ok ? { status: 200, body: params.get('hub.challenge') || '' } : { status: 403, body: 'Forbidden' };
}

// Pull inbound text messages addressed to our phone number out of a webhook payload.
// Statuses (sent/delivered/read), media, reactions etc. are ignored.
export function extractTextMessages(payload, phoneNumberId) {
  if (payload?.object !== 'whatsapp_business_account') return [];
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field !== 'messages' || value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const m of value.messages || []) {
        if (m.type === 'text' && typeof m.text?.body === 'string' && m.id && m.from) {
          out.push({ id: m.id, from: m.from, text: m.text.body, timestamp: Number(m.timestamp) || 0 });
        }
      }
    }
  }
  return out;
}

// Digits only: WhatsApp's `from` has no "+" or spaces.
export const normalizeNumber = (n) => String(n || '').replace(/\D/g, '');
