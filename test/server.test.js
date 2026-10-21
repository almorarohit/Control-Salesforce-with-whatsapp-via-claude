import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebhookServer } from '../src/server.js';
import { createSeenStore } from '../src/dedupe.js';

const SECRET = 'app-secret';
const ME = '919876543210';
const NOW = 1_800_000_000_000;

function payload(msgs, phone = 'PN1') {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, messages: msgs } }] }] });
}
const msg = (id, { from = ME, body = 'hi', ageMs = 0 } = {}) => ({ id, from, timestamp: String(Math.floor((NOW - ageMs) / 1000)), type: 'text', text: { body } });

async function setup(t, { onMessage, seenFile } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sfwa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handled = [];
  const logs = [];
  const app = createWebhookServer({
    verifyToken: 'vtok',
    appSecret: SECRET,
    phoneNumberId: 'PN1',
    allowedSender: '+91 98765 43210',
    seen: await createSeenStore(seenFile || path.join(dir, 'seen.json'), { now: () => NOW }),
    onMessage: onMessage || (async (m) => handled.push(m.text)),
    log: (l) => logs.push(l),
    now: () => NOW,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}/webhook`;
  const post = (body, sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`) =>
    fetch(base, { method: 'POST', headers: { 'X-Hub-Signature-256': sig, 'Content-Type': 'application/json' }, body });
  return { app, base, post, handled, logs, dir };
}

test('GET handshake echoes the challenge only with the right verify token', async (t) => {
  const { base } = await setup(t);
  const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');
  assert.equal((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=42`)).status, 403);
});

test('GET handshake accepts a verify-token function, so a regenerated token applies without restart', async (t) => {
  let current = 'old';
  const app = createWebhookServer({ verifyToken: async () => current, appSecret: SECRET, phoneNumberId: 'PN1', allowedSender: ME, seen: { claim: async () => true }, onMessage: async () => {}, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.server.close());
  const url = (tok) => `http://127.0.0.1:${app.server.address().port}/webhook?hub.mode=subscribe&hub.verify_token=${tok}&hub.challenge=7`;
  assert.equal((await fetch(url('new'))).status, 403);
  current = 'new';
  assert.equal((await fetch(url('new'))).status, 200);
});

test('POST with a bad or missing signature is rejected and not processed', async (t) => {
  const { post, app, handled } = await setup(t);
  assert.equal((await post(payload([msg('w1')]), 'sha256=00')).status, 401);
  assert.equal((await post(payload([msg('w1')]), '')).status, 401);
  await app.idle();
  assert.deepEqual(handled, []);
});

test('allowlisted text is acknowledged with 200 before slow processing finishes', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const handled = [];
  const { post, app } = await setup(t, { onMessage: async (m) => { await gate; handled.push(m.text); } });
  const res = await post(payload([msg('w1', { body: 'show accounts' })]));
  assert.equal(res.status, 200);
  assert.deepEqual(handled, [], 'not processed yet when 200 is returned');
  release();
  await app.idle();
  assert.deepEqual(handled, ['show accounts']);
});

test('non-allowlisted senders, other phone numbers and stale messages are ignored', async (t) => {
  const { post, app, handled } = await setup(t);
  await post(payload([msg('w1', { from: '15550001111' })]));
  await post(payload([msg('w2')], 'OTHER_PN'));
  await post(payload([msg('w3', { ageMs: 10 * 60 * 1000 })]));
  await app.idle();
  assert.deepEqual(handled, []);
});

test('duplicates are skipped, including after a restart', async (t) => {
  const first = await setup(t);
  const body = payload([msg('w1', { body: 'once' })]);
  await first.post(body);
  await first.post(body);
  await first.app.idle();
  assert.deepEqual(first.handled, ['once']);

  const second = await setup(t, { seenFile: path.join(first.dir, 'seen.json') });
  await second.post(body);
  await second.app.idle();
  assert.deepEqual(second.handled, [], 'retry after restart is not processed again');
});

test('messages are processed one at a time, in order', async (t) => {
  const events = [];
  const { post, app } = await setup(t, {
    onMessage: async (m) => {
      events.push(`start ${m.text}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end ${m.text}`);
    },
  });
  await post(payload([msg('a', { body: 'A' }), msg('b', { body: 'B' })]));
  await app.idle();
  assert.deepEqual(events, ['start A', 'end A', 'start B', 'end B']);
});

test('a failing handler is logged and does not block the next message', async (t) => {
  const handled = [];
  const { post, app, logs } = await setup(t, { onMessage: async (m) => { if (m.text === 'boom') throw new Error('kaboom'); handled.push(m.text); } });
  await post(payload([msg('a', { body: 'boom' }), msg('b', { body: 'ok' })]));
  await app.idle();
  assert.deepEqual(handled, ['ok']);
  assert.ok(logs.some((l) => l.includes('kaboom')));
  assert.ok(!logs.some((l) => l.includes('boom') && !l.includes('kaboom')), 'message text is not logged');
});

test('oversized bodies and other paths are refused', async (t) => {
  const { post, base } = await setup(t);
  assert.equal((await post('x'.repeat(300 * 1024)).catch(() => ({ status: 413 }))).status, 413);
  assert.equal((await fetch(base.replace('/webhook', '/other'))).status, 404);
});
