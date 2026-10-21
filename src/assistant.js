import { config } from './config.js';
import { createKeychain } from './keychain.js';
import { SalesforceOAuthProvider, SECRET_ACCOUNT } from './sfAuth.js';
import { connectMcp, resultText } from './mcpClient.js';
import { allowedTools, runAgent, isWriteRequest, READ_ONLY_REPLY } from './agent.js';
import { createOllamaChat } from './ollama.js';

export const keychain = createKeychain(config.keychainService);

export async function makeProvider(onRedirect) {
  return new SalesforceOAuthProvider({
    clientId: config.clientId,
    clientSecret: await keychain.get(SECRET_ACCOUNT),
    callbackPort: config.callbackPort,
    store: keychain,
    onRedirect,
  });
}

export async function withSalesforce(fn) {
  const client = await connectMcp({ serverUrl: config.mcpUrl, authProvider: await makeProvider() });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// One question in, one read-only answer out (fresh MCP session per question).
export async function answer(prompt) {
  if (isWriteRequest(prompt)) return { reply: READ_ONLY_REPLY };
  return withSalesforce(async (client) => {
    const { tools } = await client.listTools();
    return runAgent({
      prompt,
      tools: allowedTools(tools),
      chat: createOllamaChat({ host: config.ollamaHost, model: config.ollamaModel }),
      callTool: async (name, args) => resultText(await client.callTool({ name, arguments: args })),
    });
  });
}
