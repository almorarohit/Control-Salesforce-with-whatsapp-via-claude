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
  port: Number(process.env.PORT || 3000),
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    allowedSender: process.env.WHATSAPP_ALLOWED_SENDER || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v25.0',
  },
  seenFile: process.env.SEEN_FILE || 'data/seen.json',
  telegram: {
    allowedUserId: (process.env.TELEGRAM_ALLOWED_USER_ID || '').trim(),
    seenFile: process.env.TELEGRAM_SEEN_FILE || 'data/telegram-seen.json',
    apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org', // overridable for local end-to-end tests
  },
};
