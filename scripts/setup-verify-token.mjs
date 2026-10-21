#!/usr/bin/env node
// Generates a random webhook verify token, stores it in the Keychain and copies it
// to the clipboard for pasting into Meta's webhook settings. Never prints it.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { createKeychain } from '../src/keychain.js';
import { WA_VERIFY_TOKEN } from '../src/whatsapp/secrets.js';

const token = randomBytes(24).toString('hex');
await createKeychain(config.keychainService).set(WA_VERIFY_TOKEN, token);
await new Promise((resolve, reject) => {
  const p = spawn('pbcopy');
  p.on('error', reject).on('close', resolve);
  p.stdin.end(token);
});
console.log(`Verify token saved to the Keychain (${config.keychainService}/${WA_VERIFY_TOKEN}) and copied to the clipboard.`);
