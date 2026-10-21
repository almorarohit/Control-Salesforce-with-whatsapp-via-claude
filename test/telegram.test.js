import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramApi, TelegramError } from '../src/telegram/api.js';
import { toTelegramHtml, toPlainText, sendReply, MAX_TEXT } from '../src/telegram/format.js';
import { createPoller, toInboxMessage } from '../src/telegram/poller.js';
import { createTelegramHandler, HELP_TEXT } from '../src/telegram/handler.js';
import { findStarter, upsertEnv } from '../src/telegram/setup.js';
import { createInbox } from '../src/inbox.js';
import { NotLoggedInError } from '../src/sfAuth.js';

const NOW = 1_800_000_000;
const update = (id, { from = 42, chat = 'private', text = 'hi', date = NOW, isBot = false } = {}) => ({
  update_id: id,
  message: { message_id: id * 10, date, text, from: { id: from, is_bot: isBot, first_name: 'Rohit' }, chat: { id: from, type: chat } },
});

test('api: posts JSON to the method URL and keeps the token out of errors', async () => {
  const calls = [];
  const api = createTelegramApi({
    getToken: async () => 'SECRET:TOKEN',
    fetchFn: async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })),
  });
  await assert.rejects(api.sendMessage(1, 'x', { replyTo: 5, html: true }), (err) => err instanceof TelegramError && err.code === 400 && !err.message.includes('SECRET'));
  assert.equal(calls[0].url, 'https://api.telegram.org/botSECRET:TOKEN/sendMessage');
  assert.deepEqual(calls[0].body.reply_parameters, { message_id: 5, allow_sending_without_reply: true });
  assert.equal(calls[0].body.parse_mode, 'HTML');

  const netApi = createTelegramApi({ getToken: async () => 'SECRET:TOKEN', fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(netApi.getMe(), (err) => err.code === 'network' && /ENOTFOUND/.test(err.message) && !err.message.includes('SECRET'));
});

test('format: Markdown becomes safe Telegram HTML; plain fallback drops markers', () => {
  assert.equal(toTelegramHtml('## Accounts\n* **Edge** <b>x</b> & `Id`'), '<b>Accounts</b>\n• <b>Edge</b> &lt;b&gt;x&lt;/b&gt; &amp; <code>Id</code>');
  assert.equal(toPlainText('**Edge** and `Id`'), 'Edge and Id');
});

test('sendReply falls back to plain text when Telegram rejects the HTML or it is too long', async () => {
  const sent = [];
  const api = {
    sendMessage: async (chatId, text, opts) => {
      sent.push({ text, html: !!opts.html });
      if (opts.html) throw new TelegramError('sendMessage', 400, "can't parse entities");
    },
  };
  await sendReply(api, 1, '**bold**', 9);
  assert.deepEqual(sent, [{ text: '<b>bold</b>', html: true }, { text: 'bold', html: false }]);

  sent.length = 0;
  await sendReply(api, 1, 'x'.repeat(MAX_TEXT + 10), 9);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].html, false);
  assert.equal(sent[0].text.length, MAX_TEXT);
});

test('toInboxMessage keeps only private text messages', () => {
  assert.deepEqual(toInboxMessage(update(7)), { id: 'tg-7', from: '42', chatId: 42, messageId: 70, text: 'hi', timestamp: NOW });
  assert.equal(toInboxMessage(update(8, { chat: 'group' })), undefined);
  assert.equal(toInboxMessage({ update_id: 9, message: { chat: { type: 'private' }, from: { id: 1 }, photo: [] } }), undefined);
  assert.equal(toInboxMessage({ update_id: 10, edited_message: {} }), undefined);
});

test('poller advances the offset and feeds the inbox', async () => {
  const offsets = [];
  const batches = [[update(5), update(6, { chat: 'group' })], []];
  const api = { getUpdates: async ({ offset }) => (offsets.push(offset), batches.shift() || []) };
  const accepted = [];
  const poller = createPoller({ api, inbox: { accept: (m) => accepted.push(m.id) }, log: () => {} });
  assert.equal(await poller.pollOnce(), 2);
  await poller.pollOnce();
  assert.deepEqual(offsets, [undefined, 7]);
  assert.deepEqual(accepted, ['tg-5']);
});

test('poller backs off on errors, honours retry_after, and stops on a bad token', async () => {
  const waits = [];
  const errors = [new TelegramError('getUpdates', 'network', 'ECONNRESET'), new TelegramError('getUpdates', 429, 'Too Many Requests', 7), new TelegramError('getUpdates', 409, 'Conflict')];
  const controller = new AbortController();
  const api = {
    getUpdates: async () => {
      const err = errors.shift();
      if (err) throw err;
      throw new TelegramError('getUpdates', 401, 'Unauthorized');
    },
  };
  const logs = [];
  const poller = createPoller({ api, inbox: { accept() {} }, log: (l) => logs.push(l), sleep: async (ms) => waits.push(ms) });
  await assert.rejects(poller.run(controller.signal), /store-secret -- tg-bot-token/);
  assert.deepEqual(waits, [1000, 7000, 4000]);
  assert.ok(logs.some((l) => l.startsWith('conflict')));
});

function fakeApi() {
  const sent = [];
  let typing = 0;
  return { sent, get typing() { return typing; }, sendMessage: async (chatId, text, opts) => sent.push({ chatId, text, opts }), sendTyping: async () => void typing++ };
}

test('handler answers /start and /help locally without calling the agent', async () => {
  const api = fakeApi();
  const handle = createTelegramHandler({ api, answer: assert.fail, log: () => {} });
  await handle({ chatId: 42, messageId: 1, text: '/start' });
  await handle({ chatId: 42, messageId: 2, text: '/help@my_bot' });
  assert.equal(api.sent.length, 2);
  assert.ok(api.sent[0].text.includes('read-only questions'));
  assert.equal(HELP_TEXT.length < MAX_TEXT, true);
});

test('handler shows typing, replies with the agent answer as a reply to the message', async () => {
  const api = fakeApi();
  const handle = createTelegramHandler({ api, answer: async (q) => ({ reply: `**${q}**`, toolCall: { name: 'soqlQuery' } }), log: () => {}, typingEveryMs: 5 });
  await handle({ chatId: 42, messageId: 3, text: ' show accounts ' });
  assert.ok(api.typing >= 1);
  assert.deepEqual(api.sent, [{ chatId: 42, text: '<b>show accounts</b>', opts: { replyTo: 3, html: true } }]);
});

test('handler turns agent failures into friendly replies', async () => {
  const api = fakeApi();
  await createTelegramHandler({ api, answer: async () => { throw new NotLoggedInError(); }, log: () => {} })({ chatId: 1, messageId: 1, text: 'q' });
  await createTelegramHandler({ api, answer: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }, log: () => {} })({ chatId: 1, messageId: 2, text: 'q' });
  assert.match(api.sent[0].text, /npm run login/);
  assert.match(api.sent[1].text, /Ollama/);
  assert.ok(!api.sent[1].text.includes('ECONNREFUSED'), 'internal error details are not sent to the chat');
});

test('allowlist via the shared inbox: only the owner reaches the handler', async () => {
  const handled = [];
  const inbox = createInbox({ isAllowed: (m) => m.from === '42', seen: { claim: async () => true }, onMessage: async (m) => handled.push(m.text), log: () => {}, now: () => NOW * 1000 });
  inbox.accept(toInboxMessage(update(1, { from: 42, text: 'mine' })));
  inbox.accept(toInboxMessage(update(2, { from: 99, text: 'stranger' })));
  await inbox.idle();
  assert.deepEqual(handled, ['mine']);
});

test('setup helpers: find the first private /start from a human, and upsert .env', () => {
  assert.equal(findStarter([update(1, { text: 'hello' }), update(2, { chat: 'group', text: '/start' })]), undefined);
  assert.deepEqual(findStarter([update(3, { text: '/start', from: 555 })]), { updateId: 3, userId: '555', chatId: 555, name: 'Rohit', username: undefined });
  assert.equal(findStarter([update(4, { text: '/start', isBot: true })]), undefined);

  assert.equal(upsertEnv('A=1\nTELEGRAM_ALLOWED_USER_ID=\nB=2\n', 'TELEGRAM_ALLOWED_USER_ID', '555'), 'A=1\nTELEGRAM_ALLOWED_USER_ID=555\nB=2\n');
  assert.equal(upsertEnv('A=1', 'TELEGRAM_ALLOWED_USER_ID', '555'), 'A=1\nTELEGRAM_ALLOWED_USER_ID=555\n');
  assert.equal(upsertEnv('', 'X', '1'), 'X=1\n');
});
