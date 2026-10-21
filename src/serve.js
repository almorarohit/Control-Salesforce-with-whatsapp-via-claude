#!/usr/bin/env node
// WhatsApp webhook server. Usage: npm run serve   (or: npm run serve -- --dry-run)
// --dry-run prints replies instead of sending them and falls back to fixed local
// secrets when the Keychain has none, so it works with scripts/simulate-webhook.mjs.
import { config } from './config.js';
import { keychain, answer } from './assistant.js';
import { createSeenStore } from './dedupe.js';
import { createWebhookServer } from './server.js';
import { createWhatsAppSender, toWhatsAppText } from './whatsapp/send.js';
import { NotLoggedInError } from './sfAuth.js';
import { WA_APP_SECRET, WA_ACCESS_TOKEN, WA_VERIFY_TOKEN, DRY_RUN_SECRET, DRY_RUN_VERIFY_TOKEN } from './whatsapp/secrets.js';

const dryRun = process.argv.includes('--dry-run');
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

async function secret(account, dryRunFallback) {
  const value = await keychain.get(account);
  if (value) return value;
  if (dryRun) return dryRunFallback;
  throw new Error(`Missing Keychain item ${config.keychainService}/${account}. See README (Phase 4 setup).`);
}

const appSecret = await secret(WA_APP_SECRET, DRY_RUN_SECRET);
await secret(WA_VERIFY_TOKEN, DRY_RUN_VERIFY_TOKEN); // fail fast if missing
const verifyToken = () => secret(WA_VERIFY_TOKEN, DRY_RUN_VERIFY_TOKEN);
const { phoneNumberId, allowedSender, graphVersion } = config.whatsapp;

const sendText = dryRun
  ? async (to, body) => log(`[dry-run] reply to …${to.slice(-4)}:\n${toWhatsAppText(body)}`)
  : createWhatsAppSender({ graphVersion, phoneNumberId, getToken: () => secret(WA_ACCESS_TOKEN) });

async function onMessage(msg) {
  let reply;
  try {
    const result = await answer(msg.text);
    if (result.toolCall) log(`tool ${result.toolCall.name}${result.error ? ` blocked: ${result.error}` : ''}`);
    reply = result.reply || 'Sorry, I had no answer for that.';
  } catch (err) {
    log(`agent error: ${err.message}`);
    reply = err instanceof NotLoggedInError ? 'My Salesforce login has expired. Run `npm run login` on the Mac.' : 'Sorry, something went wrong on my side.';
  }
  await sendText(msg.from, reply, msg.id);
}

const { server } = createWebhookServer({
  verifyToken,
  appSecret,
  phoneNumberId,
  allowedSender,
  seen: await createSeenStore(config.seenFile),
  onMessage,
  log,
});

server.listen(config.port, '127.0.0.1', () => log(`webhook listening on http://127.0.0.1:${config.port}/webhook${dryRun ? ' (dry run)' : ''}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
