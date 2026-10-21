#!/usr/bin/env node
// Telegram bot (long polling). Usage: npm run bot
import { config } from './config.js';
import { keychain, answer } from './assistant.js';
import { createSeenStore } from './dedupe.js';
import { createInbox } from './inbox.js';
import { createTelegramApi } from './telegram/api.js';
import { createPoller } from './telegram/poller.js';
import { createTelegramHandler } from './telegram/handler.js';
import { TG_BOT_TOKEN } from './telegram/secrets.js';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function getToken() {
  const token = await keychain.get(TG_BOT_TOKEN);
  if (!token) throw new Error(`Missing Keychain item ${config.keychainService}/${TG_BOT_TOKEN}. Run: npm run store-secret -- ${TG_BOT_TOKEN}`);
  return token;
}

const allowedUserId = config.telegram.allowedUserId;
if (!/^\d+$/.test(allowedUserId)) {
  console.error('TELEGRAM_ALLOWED_USER_ID is not set in .env. Run: npm run telegram:setup');
  process.exit(1);
}

const api = createTelegramApi({ getToken, base: config.telegram.apiBase });
try {
  const me = await api.getMe();
  await api.deleteWebhook(); // getUpdates doesn't work while a webhook is set
  log(`connected as @${me.username}; only Telegram user …${allowedUserId.slice(-4)} is allowed`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const inbox = createInbox({
  isAllowed: (m) => m.from === allowedUserId,
  seen: await createSeenStore(config.telegram.seenFile),
  onMessage: createTelegramHandler({ api, answer, log }),
  log,
});

const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('stopping…');
    controller.abort();
  });
}

await createPoller({ api, inbox, log })
  .run(controller.signal)
  .catch((err) => {
    log(err.message);
    process.exitCode = 1;
  });
await inbox.idle();
