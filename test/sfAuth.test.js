import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SalesforceOAuthProvider, NotLoggedInError, TOKEN_ACCOUNT, startCallbackServer, revokeStoredToken } from '../src/sfAuth.js';

function memoryStore() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), remove: async (k) => void m.delete(k) };
}

const make = (store, extra = {}) => new SalesforceOAuthProvider({ clientId: 'cid', callbackPort: 38001, store, ...extra });

test('provider requires a client id and uses the registered callback URL', () => {
  assert.throws(() => new SalesforceOAuthProvider({ store: memoryStore() }), /SF_CLIENT_ID/);
  const p = make(memoryStore());
  assert.equal(p.redirectUrl, 'http://localhost:38001/callback');
  assert.equal(p.clientInformation().token_endpoint_auth_method, 'none');
  assert.equal(make(memoryStore(), { clientSecret: 's' }).clientInformation().client_secret, 's');
});

test('only the refresh token and issuer are persisted', async () => {
  const store = memoryStore();
  const p = make(store);
  assert.equal(await p.tokens(), undefined);
  await p.saveTokens({ access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', issuer: 'https://login.salesforce.com' });
  assert.deepEqual(JSON.parse(store.m.get(TOKEN_ACCOUNT)), { refresh_token: 'RT', issuer: 'https://login.salesforce.com' });
  assert.equal((await p.tokens()).access_token, 'AT');
  assert.equal((await make(store).tokens()).access_token, '', 'a new process has no access token in memory');
  await p.invalidateCredentials('tokens');
  assert.equal(store.m.size, 0);
});

test('without a login handler, an authorization redirect throws NotLoggedInError', () => {
  assert.throws(() => make(memoryStore()).redirectToAuthorization(new URL('https://example.com')), NotLoggedInError);
});

test('callback server rejects a wrong state and resolves the code for the right one', async () => {
  const cb = await startCallbackServer({ port: 0, getExpectedState: () => 'good' });
  const base = `http://127.0.0.1:${cb.port}/callback`;
  assert.equal((await fetch(`${base}?code=c&state=bad`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${cb.port}/other`)).status, 404);
  assert.equal((await fetch(`${base}?code=the-code&state=good`)).status, 200);
  assert.equal(await cb.code, 'the-code');
});

test('callback server surfaces a Salesforce error', async () => {
  const cb = await startCallbackServer({ port: 0, getExpectedState: () => 'good' });
  await fetch(`http://127.0.0.1:${cb.port}/callback?error=access_denied&state=good`);
  await assert.rejects(cb.code, /access_denied/);
});

test('logout revokes at the discovered endpoint and deletes the local token', async () => {
  const store = memoryStore();
  await store.set(TOKEN_ACCOUNT, JSON.stringify({ refresh_token: 'RT', issuer: 'https://login.example' }));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push([String(url), init?.body?.toString()]);
    return String(url).endsWith('openid-configuration') ? Response.json({ revocation_endpoint: 'https://login.example/revoke' }) : new Response('', { status: 200 });
  };
  assert.equal(await revokeStoredToken(store, fakeFetch), true);
  assert.deepEqual(calls[1], ['https://login.example/revoke', 'token=RT']);
  assert.equal(store.m.size, 0);
  assert.equal(await revokeStoredToken(store, fakeFetch), false);
});
