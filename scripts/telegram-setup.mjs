#!/usr/bin/env node
// One-time link of your Telegram account to the bot.
// 1. Checks the bot token (Keychain) and prints the bot's link.
// 2. Waits up to 5 minutes for you to send /start to the bot.
// 3. Saves your numeric user ID as TELEGRAM_ALLOWED_USER_ID in .env and confirms in the chat.
// Usage: npm run telegram:setup   (add -- --force to replace an existing user ID)
import { readFile, writeFile } from 'node:fs/promises';
import { config } from '../src/config.js';
import { createKeychain } from '../src/keychain.js';
import { createTelegramApi } from '../src/telegram/api.js';
import { TG_BOT_TOKEN } from '../src/telegram/secrets.js';
import { findStarter, upsertEnv } from '../src/telegram/setup.js';

const ENV_FILE = '.env';
const WAIT_MS = 5 * 60 * 1000;

if (config.telegram.allowedUserId && !process.argv.includes('--force')) {
  console.log(`TELEGRAM_ALLOWED_USER_ID is already set (…${config.telegram.allowedUserId.slice(-4)}). Use: npm run telegram:setup -- --force to replace it.`);
  process.exit(0);
}

const keychain = createKeychain(config.keychainService);
const token = await keychain.get(TG_BOT_TOKEN);
if (!token) {
  console.error(`No bot token in the Keychain. Copy it from @BotFather, then run: npm run store-secret -- ${TG_BOT_TOKEN}`);
  process.exit(1);
}
const api = createTelegramApi({ getToken: async () => token });

let me;
try {
  me = await api.getMe();
  await api.deleteWebhook();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`Bot token OK: @${me.username}\nOpen https://t.me/${me.username} on your phone and tap Start (or send /start). Waiting up to 5 minutes…`);

const deadline = Date.now() + WAIT_MS;
let offset;
let starter;
while (!starter && Date.now() < deadline) {
  const updates = await api.getUpdates({ offset, timeout: 30 });
  starter = findStarter(updates);
  if (updates.length) offset = updates.at(-1).update_id + 1;
}
if (!starter) {
  console.error('No /start received within 5 minutes. Run npm run telegram:setup again.');
  process.exit(1);
}
await api.getUpdates({ offset: starter.updateId + 1, timeout: 0 }); // confirm, so the bot doesn't answer the /start again

let env = '';
try {
  env = await readFile(ENV_FILE, 'utf8');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
await writeFile(ENV_FILE, upsertEnv(env, 'TELEGRAM_ALLOWED_USER_ID', starter.userId));
await api.sendMessage(starter.chatId, `Linked ✅ Only you can use this bot now. Start it on the Mac with npm run bot, then ask e.g. "show me 3 account names".`);

console.log(`Linked Telegram user "${starter.name}"${starter.username ? ` (@${starter.username})` : ''}, ID …${starter.userId.slice(-4)}. Saved TELEGRAM_ALLOWED_USER_ID to .env.
If that isn't you, run npm run telegram:setup -- --force and try again.`);
