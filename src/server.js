import http from 'node:http';
import { verifySignature, handleVerify, extractTextMessages, normalizeNumber } from './whatsapp/webhook.js';

const MAX_BODY = 256 * 1024;
export const MAX_AGE_MS = 5 * 60 * 1000;

const mask = (n) => `…${String(n).slice(-4)}`;
const shortId = (id) => `…${String(id).slice(-8)}`;

// Webhook HTTP server. Acknowledges valid deliveries immediately (Meta times out in
// seconds; the model takes longer), then handles messages one at a time in the background.
export function createWebhookServer({ verifyToken, appSecret, phoneNumberId, allowedSender, seen, onMessage, log = console.log, now = Date.now, maxAgeMs = MAX_AGE_MS }) {
  const allowed = normalizeNumber(allowedSender);
  if (!allowed) throw new Error('WHATSAPP_ALLOWED_SENDER is not set');
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set');

  let queue = Promise.resolve();

  async function accept(msg) {
    if (normalizeNumber(msg.from) !== allowed) return log(`ignored message ${shortId(msg.id)} from non-allowlisted ${mask(msg.from)}`);
    if (!(await seen.claim(msg.id))) return log(`duplicate ${shortId(msg.id)} skipped`);
    if (now() - msg.timestamp * 1000 > maxAgeMs) return log(`stale ${shortId(msg.id)} skipped`);
    queue = queue.then(async () => {
      const t0 = now();
      try {
        await onMessage(msg);
        log(`handled ${shortId(msg.id)} in ${((now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        log(`failed ${shortId(msg.id)}: ${err.message}`);
      }
    });
  }

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
      for (const msg of extractTextMessages(payload, phoneNumberId)) {
        const p = accept(msg).catch((err) => log(`accept failed ${shortId(msg.id)}: ${err.message}`));
        accepting.add(p);
        p.finally(() => accepting.delete(p));
      }
    });
  });

  const accepting = new Set();
  // Resolves once every accepted message has been handled (used by tests and shutdown).
  async function idle() {
    while (accepting.size) await Promise.all(accepting);
    await queue;
  }

  return { server, idle };
}
