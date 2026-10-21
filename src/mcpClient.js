import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

// Connect to an MCP server over Streamable HTTP. With an authProvider, tokens are
// refreshed up front so a missing login fails fast instead of mid-request.
export async function connectMcp({ serverUrl, authProvider }) {
  if (authProvider) {
    const result = await auth(authProvider, { serverUrl });
    if (result !== 'AUTHORIZED') throw new Error(`Unexpected auth result: ${result}`);
  }
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
  const client = new Client({ name: 'sf-whatsapp-copilot', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

// Flatten an MCP tool result to text for the model.
export function resultText(result) {
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return result.isError ? `Tool error: ${text}` : text;
}
