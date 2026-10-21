import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, handleVerify, extractTextMessages, normalizeNumber } from '../src/whatsapp/webhook.js';
import { createWhatsAppSender, toWhatsAppText } from '../src/whatsapp/send.js';

const sign = (body, secret = 's3cret') => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('verifySignature accepts the exact bytes and rejects tampering, wrong secret and bad headers', () => {
  const raw = Buffer.from('{"msg":"héllo"}');
  assert.equal(verifySignature(raw, sign(raw), 's3cret'), true);
  assert.equal(verifySignature(Buffer.from('{"msg":"hello"}'), sign(raw), 's3cret'), false);
  assert.equal(verifySignature(raw, sign(raw, 'other'), 's3cret'), false);
  assert.equal(verifySignature(raw, undefined, 's3cret'), false);
  assert.equal(verifySignature(raw, 'sha1=abc', 's3cret'), false);
  assert.equal(verifySignature(raw, 'sha256=zz', 's3cret'), false);
  assert.equal(verifySignature(raw, sign(raw, ''), ''), false, 'empty secret never validates');
});

test('handleVerify returns the challenge only for subscribe with the right token', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(handleVerify(q('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123'), 'tok'), { status: 200, body: '123' });
  assert.equal(handleVerify(q('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123'), 'tok').status, 403);
  assert.equal(handleVerify(q('hub.mode=unsubscribe&hub.verify_token=tok&hub.challenge=123'), 'tok').status, 403);
  assert.equal(handleVerify(q('hub.mode=subscribe&hub.challenge=123'), 'tok').status, 403);
  assert.equal(handleVerify(q('hub.mode=subscribe&hub.verify_token=&hub.challenge=1'), '').status, 403);
});

test('extractTextMessages keeps text messages for our number, ignores statuses, media and other numbers', () => {
  const change = (phone, value) => ({ field: 'messages', value: { metadata: { phone_number_id: phone }, ...value } });
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [
        change('PN1', { messages: [{ id: 'w1', from: '911', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }, { id: 'w2', from: '911', type: 'image', image: {} }] }),
        change('PN1', { statuses: [{ id: 'w0', status: 'delivered' }] }),
        change('OTHER', { messages: [{ id: 'w3', from: '911', type: 'text', text: { body: 'x' } }] }),
      ],
    }],
  };
  assert.deepEqual(extractTextMessages(payload, 'PN1'), [{ id: 'w1', from: '911', text: 'hi', timestamp: 1700000000 }]);
  assert.deepEqual(extractTextMessages({ object: 'page' }, 'PN1'), []);
});

test('normalizeNumber strips formatting', () => {
  assert.equal(normalizeNumber('+91 98765-43210'), '919876543210');
});

test('sender posts a text reply with context and truncates long bodies', async () => {
  let req;
  const send = createWhatsAppSender({
    graphVersion: 'v25.0',
    phoneNumberId: 'PN1',
    getToken: async () => 'TOKEN',
    fetchFn: async (url, init) => ((req = { url, init }), Response.json({ messages: [{ id: 'out1' }] })),
  });
  assert.equal(await send('911', 'x'.repeat(5000), 'w1'), 'out1');
  assert.equal(req.url, 'https://graph.facebook.com/v25.0/PN1/messages');
  assert.equal(req.init.headers.Authorization, 'Bearer TOKEN');
  const body = JSON.parse(req.init.body);
  assert.equal(body.text.body.length, 4096);
  assert.deepEqual(body.context, { message_id: 'w1' });
});

test('toWhatsAppText converts Markdown bold, headings and bullets', () => {
  assert.equal(toWhatsAppText('## Accounts\n* **Edge** Communications\n- __x__'), 'Accounts\n• *Edge* Communications\n• _x_');
});

test('sender surfaces Meta errors without leaking the token', async () => {
  const send = createWhatsAppSender({ graphVersion: 'v25.0', phoneNumberId: 'PN1', getToken: async () => 'TOKEN', fetchFn: async () => Response.json({ error: { message: 'Invalid OAuth access token' } }, { status: 401 }) });
  await assert.rejects(send('911', 'hi'), (err) => /401.*Invalid OAuth/.test(err.message) && !err.message.includes('TOKEN'));
});
