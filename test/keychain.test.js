import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeychain } from '../src/keychain.js';

// Uses a throwaway service name in the real login keychain and cleans up after itself.
test('keychain set/get/remove round-trips values with quotes and spaces', { skip: process.platform !== 'darwin' }, async () => {
  const kc = createKeychain('sf-whatsapp-copilot-test');
  const value = JSON.stringify({ refresh_token: 'a b"c', issuer: 'https://login.salesforce.com' });
  try {
    assert.equal(await kc.get('probe'), undefined);
    await kc.set('probe', value);
    assert.equal(await kc.get('probe'), value);
    await kc.set('probe', 'updated');
    assert.equal(await kc.get('probe'), 'updated');
  } finally {
    await kc.remove('probe');
  }
  assert.equal(await kc.get('probe'), undefined);
  await kc.remove('probe'); // removing a missing item is a no-op
});
