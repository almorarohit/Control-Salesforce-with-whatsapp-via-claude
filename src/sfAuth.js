import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const TOKEN_ACCOUNT = 'sf-refresh-token';
export const SECRET_ACCOUNT = 'sf-client-secret';

export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in to Salesforce. Run: npm run login');
  }
}

// OAuthClientProvider for the MCP SDK, using the pre-registered External Client App.
// Only the refresh token (plus its issuer) is persisted; access tokens stay in memory.
export class SalesforceOAuthProvider {
  constructor({ clientId, clientSecret, callbackPort, store, onRedirect }) {
    if (!clientId) throw new Error('SF_CLIENT_ID is not set in .env');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackPort = callbackPort;
    this.store = store;
    this.onRedirect = onRedirect || (() => { throw new NotLoggedInError(); });
    this.expectedState = undefined;
    this._clientIssuer = undefined;
    this._accessToken = undefined;
    this._verifier = undefined;
    this._discovery = undefined;
  }

  get redirectUrl() {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get authMethod() {
    return this.clientSecret ? 'client_secret_post' : 'none';
  }

  get clientMetadata() {
    return {
      client_name: 'SF WhatsApp Copilot',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.authMethod,
    };
  }

  state() {
    this.expectedState = randomBytes(16).toString('hex');
    return this.expectedState;
  }

  clientInformation() {
    return {
      client_id: this.clientId,
      ...(this.clientSecret && { client_secret: this.clientSecret }),
      token_endpoint_auth_method: this.authMethod,
      ...(this._clientIssuer && { issuer: this._clientIssuer }),
    };
  }

  saveClientInformation(info) {
    this._clientIssuer = info.issuer;
  }

  async tokens() {
    const raw = await this.store.get(TOKEN_ACCOUNT);
    if (!raw) return undefined;
    const { refresh_token, issuer } = JSON.parse(raw);
    return { access_token: this._accessToken || '', token_type: 'Bearer', refresh_token, issuer };
  }

  async saveTokens(tokens) {
    this._accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      await this.store.set(TOKEN_ACCOUNT, JSON.stringify({ refresh_token: tokens.refresh_token, issuer: tokens.issuer }));
    }
  }

  redirectToAuthorization(url) {
    return this.onRedirect(url);
  }

  saveCodeVerifier(verifier) {
    this._verifier = verifier;
  }

  codeVerifier() {
    if (!this._verifier) throw new Error('No PKCE code verifier for this login attempt');
    return this._verifier;
  }

  saveDiscoveryState(state) {
    this._discovery = state;
  }

  discoveryState() {
    return this._discovery;
  }

  async invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'tokens') {
      this._accessToken = undefined;
      await this.store.remove(TOKEN_ACCOUNT);
    }
    if (scope === 'all' || scope === 'verifier') this._verifier = undefined;
    if (scope === 'all' || scope === 'discovery') this._discovery = undefined;
    if (scope === 'all' || scope === 'client') this._clientIssuer = undefined;
  }
}

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>SF WhatsApp Copilot</title><p>${msg}</p>`;

// One-shot OAuth callback listener on loopback only. Resolves with the authorization
// code once a request arrives carrying the state the provider generated.
export async function startCallbackServer({ port, getExpectedState, timeoutMs = 5 * 60_000 }) {
  let settle;
  const code = new Promise((resolve, reject) => (settle = { resolve, reject }));

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const expected = getExpectedState();
    if (!expected || url.searchParams.get('state') !== expected) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Login state did not match. Close this tab and run <code>npm run login</code> again.'));
      return;
    }
    const error = url.searchParams.get('error') || (url.searchParams.get('code') ? '' : 'missing_code');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Salesforce login failed. You can close this tab.'));
      settle.reject(new Error(`Salesforce login failed: ${error} ${url.searchParams.get('error_description') || ''}`.trim()));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Logged in. You can close this tab.'));
    settle.resolve(url.searchParams.get('code'));
  };

  // `localhost` may resolve to either loopback address, so listen on both (never on external interfaces).
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => server.once('error', reject).listen(host === '::1' && servers[0] ? servers[0].address().port : port, host, resolve));
      servers.push(server);
    } catch (err) {
      if (host === '127.0.0.1') throw err;
    }
  }

  const timer = setTimeout(() => settle.reject(new Error('Timed out waiting for the Salesforce login callback')), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    for (const s of servers) s.close();
  };
  code.then(close, close);
  return { port: servers[0].address().port, code, close };
}

// Revoke the stored refresh token at Salesforce, then delete it locally.
export async function revokeStoredToken(store, fetchFn = fetch) {
  const raw = await store.get(TOKEN_ACCOUNT);
  if (!raw) return false;
  const { refresh_token, issuer } = JSON.parse(raw);
  try {
    const meta = await (await fetchFn(new URL('/.well-known/openid-configuration', issuer))).json();
    const res = await fetchFn(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refresh_token }),
    });
    if (!res.ok) console.warn(`Salesforce revoke returned ${res.status}; deleting the local token anyway.`);
  } finally {
    await store.remove(TOKEN_ACCOUNT);
  }
  return true;
}
