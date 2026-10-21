import dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Non-secret settings only. Secrets (client secret, refresh token) live in the macOS Keychain.
export const config = {
  mcpUrl: process.env.SF_MCP_URL || 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads',
  clientId: process.env.SF_CLIENT_ID || '',
  callbackPort: Number(process.env.SF_OAUTH_CALLBACK_PORT || 38000),
  ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:4b',
  keychainService: 'sf-whatsapp-copilot',
};
