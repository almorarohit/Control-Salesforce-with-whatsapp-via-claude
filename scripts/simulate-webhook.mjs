#!/usr/bin/env node
// Sends a correctly signed fake WhatsApp text message to the local webhook, as Meta would.
// Usage: node scripts/simulate-webhook.mjs "show me 3 account names" [--from 15551234567] [--bad-signature]
// Uses the Keychain app secret if present, else the dry-run secret (matches `npm run serve -- --dry-run`).
import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { createKeychain } from '../src/keychain.js';
import { WA_APP_SECRET, DRY_RUN_SECRET } from '../src/whatsapp/secrets.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, name.startsWith('--bad') ? 1 : 2)[1] ?? true;
};
const from = flag('--from') || config.whatsapp.allowedSender.replace(/\D/g, '');
const badSignature = flag('--bad-signature');
const text = args.join(' ') || 'show me 3 account names';

const appSecret = (await createKeychain(config.keychainService).get(WA_APP_SECRET)) || DRY_RUN_SECRET;
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'SIMULATED_WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: config.whatsapp.phoneNumberId },
        contacts: [{ wa_id: from, profile: { name: 'Simulator' } }],
        messages: [{ from, id: `wamid.SIM_${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
      },
    }],
  }],
};
const raw = JSON.stringify(payload);
const signature = `sha256=${createHmac('sha256', badSignature ? 'wrong-secret' : appSecret).update(raw).digest('hex')}`;

const res = await fetch(`http://127.0.0.1:${config.port}/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body: raw,
});
console.log(`POST /webhook → ${res.status}`);
