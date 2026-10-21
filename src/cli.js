#!/usr/bin/env node
// Usage: npm run login | npm run logout | npm run tools | npm run ask -- "show 3 accounts"
import { execFile } from 'node:child_process';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from './config.js';
import { startCallbackServer, revokeStoredToken } from './sfAuth.js';
import { allowedTools } from './agent.js';
import { keychain, makeProvider, withSalesforce, answer } from './assistant.js';

async function login() {
  let provider;
  const callback = await startCallbackServer({ port: config.callbackPort, getExpectedState: () => provider.expectedState });
  provider = await makeProvider((url) => {
    console.log(`Opening Salesforce login in your browser. If it doesn't open, visit:\n${url}\n`);
    execFile('open', [url.toString()]);
  });
  try {
    await provider.invalidateCredentials('tokens');
    await auth(provider, { serverUrl: config.mcpUrl });
    const code = await callback.code;
    const result = await auth(provider, { serverUrl: config.mcpUrl, authorizationCode: code });
    if (result !== 'AUTHORIZED') throw new Error(`Login did not complete (${result})`);
    console.log('Logged in. Refresh token saved to the macOS Keychain.');
  } finally {
    callback.close();
  }
}

const commands = {
  login,

  async logout() {
    console.log((await revokeStoredToken(keychain)) ? 'Token revoked and removed from the Keychain.' : 'No stored token.');
  },

  tools: () =>
    withSalesforce(async (client) => {
      const { tools } = await client.listTools();
      const allowed = new Set(allowedTools(tools).map((t) => t.name));
      for (const t of tools) console.log(`${allowed.has(t.name) ? '✔' : '✘'} ${t.name}  ${JSON.stringify(t.inputSchema?.properties || {})}`);
    }),

  async ask(...words) {
    const prompt = words.join(' ').trim();
    if (!prompt) throw new Error('Usage: npm run ask -- "your question"');
    const result = await answer(prompt);
    if (result.toolCall) console.error(`[tool] ${result.toolCall.name} ${JSON.stringify(result.toolCall.args)}${result.error ? ` — blocked: ${result.error}` : ''}`);
    console.log(result.reply);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error('Usage: node src/cli.js <login|logout|tools|ask> [question]');
  process.exit(2);
}
commands[cmd](...args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
