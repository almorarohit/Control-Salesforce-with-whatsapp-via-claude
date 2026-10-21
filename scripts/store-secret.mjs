#!/usr/bin/env node
// Stores the clipboard contents as a Keychain secret without printing it.
// Usage: copy the value, then: npm run store-secret -- wa-access-token
// (`security add-generic-password -w` prompts truncate input at 128 characters; this doesn't.)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { createKeychain } from '../src/keychain.js';
import { WA_ACCESS_TOKEN, WA_APP_SECRET } from '../src/whatsapp/secrets.js';
import { SECRET_ACCOUNT } from '../src/sfAuth.js';
import { TG_BOT_TOKEN } from '../src/telegram/secrets.js';

const ACCOUNTS = [TG_BOT_TOKEN, WA_ACCESS_TOKEN, WA_APP_SECRET, SECRET_ACCOUNT];
const account = process.argv[2];
if (!ACCOUNTS.includes(account)) {
  console.error(`Usage: npm run store-secret -- <${ACCOUNTS.join('|')}>`);
  process.exit(2);
}

const { stdout } = await promisify(execFile)('pbpaste');
const value = stdout.trim();
if (!value || /\s/.test(value)) {
  console.error('Clipboard is empty or contains spaces/newlines; copy just the secret and try again.');
  process.exit(1);
}
await createKeychain(config.keychainService).set(account, value);
console.log(`Stored ${config.keychainService}/${account} (${value.length} characters). You can now copy something else to clear the clipboard.`);
