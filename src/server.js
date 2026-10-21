import http from 'node:http';
import { verifySignature, handleVerify, extractTextMessages, normalizeNumber } from './whatsapp/webhook.js';
import { createInbox, MAX_AGE_MS } from './inbox.js';

export { MAX_AGE_MS };

const MAX_BODY = 256 * 1024;

// WhatsApp webhook HTTP server. Acknowledges valid deliveries immediately (Meta times out
// in seconds; the model takes longer), then hands messages to the shared inbox.
export function createWebhookServer({ verifyToken, appSecret, phoneNumberId, allowedSender, seen, onMessage, log = console.log, now = Date.now, maxAgeMs = MAX_AGE_MS }) {
  const allowed = normalizeNumber(allowedSender);
  if (!allowed) throw new Error('WHATSAPP_ALLOWED_SENDER is not set');
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');

  const inbox = createInbox({ isAllowed: (m) => normalizeNumber(m.from) === allowed, seen, onMessage, log, now, maxAgeMs });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/webhook') return res.writeHead(404).end();

    if (req.method === 'GET') {
      // verifyToken may be a function so a regenerated token applies without a restart.
      Promise.resolve(typeof verifyToken === 'function' ? verifyToken() : verifyToken)
        .then((token) => handleVerify(url.searchParams, token))
        .catch(() => ({ status: 500, body: '' }))
        .then(({ status, body }) => {
          log(`verify handshake → ${status}`);
          res.writeHead(status, { 'Content-Type': 'text/plain' }).end(body);
        });
      return;
    }
    if (req.method !== 'POST') return res.writeHead(405).end();

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], appSecret)) {
        log('rejected POST with bad signature');
        return res.writeHead(401).end();
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.writeHead(400).end();
      }
      res.writeHead(200).end();
      for (const msg of extractTextMessages(payload, phoneNumberId)) inbox.accept(msg);
    });
  });

  return { server, idle: inbox.idle };
}
