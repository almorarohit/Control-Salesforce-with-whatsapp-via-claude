# SF WhatsApp Copilot

Control a personal Salesforce Developer Edition org from WhatsApp chat, using a local AI model and Salesforce's hosted MCP servers.

## Constraints

- **Zero additional spend.** No paid APIs, hosting or services.
- **Hosted Salesforce MCP** instead of a custom Salesforce MCP server.
- **Local development** on macOS.
- **No secrets in Git.** Credentials, OAuth tokens and keys stay in `.env` (git-ignored) or the macOS Keychain.
- **One org only:** the personal Developer Edition org.

## Architecture

```
You (WhatsApp) ──► Meta Cloud API (free test number)
                        │ webhook (HTTPS)
                        ▼
              Free tunnel (Cloudflare quick tunnel / ngrok free)
                        │
                        ▼
      Local Node backend (localhost)
        ├─ verifies X-Hub-Signature-256
        ├─ accepts messages only from the allowed sender
        ├─ Ollama (local model) ◄─► MCP client
        │                               │ OAuth (PKCE)
        │                               ▼
        │          Salesforce hosted MCP (api.salesforce.com)
        │                               ▼
        │                 Developer Edition org
        └─ replies to WhatsApp (free-form replies only, no templates)

Separately, for development: Claude Code ◄─► the same Salesforce MCP server
```

The backend and Claude Code are separate MCP clients with separate OAuth tokens.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Salesforce SObject Reads MCP + External Client App, Claude Code connected | Done |
| 1 | Project skeleton: Git, `.gitignore`, `.env.example`, README | Done |
| 2 | Ollama + ~4B model, tool calling tested against stubbed tools | Done |
| 3 | Node backend MCP client with its own OAuth (PKCE), tokens in Keychain | Done |
| 4 | Meta app, test number, webhook with signature check, sender allowlist, dedupe, tunnel | — |
| 5 | "Reply YES" before writes, monthly reply guard, redacted logs | — |
| 6 | Optional: Claude Code headless as the backend's brain | — |

## Setup

1. Copy the env template and fill it in locally:
   ```bash
   cp .env.example .env
   ```
2. Claude Code's Salesforce connection (`salesforce-reads`) is configured per user with `claude mcp add`, not in this repo.

## Local AI (Phase 2)

Ollama is installed from the `ollama-app` Homebrew cask (the `ollama` formula builds from source on macOS 14). The model is `qwen3.5:4b` (~4 GB on disk, ~5.6 GB in memory at a 4K context), run with thinking off.

```bash
OLLAMA_HOST=127.0.0.1:11434 ollama serve
```

```bash
node scripts/ollama-tool-test.mjs qwen3.5:4b
```

The test runs offline against stubs named after the SObject Reads tools. It checks tool choice, validates arguments, and checks that write/delete requests are declined.

## Salesforce backend client (Phase 3)

The backend is its own MCP client with its own tokens. It reuses the **Claude Code MCP** External Client App and its callback `http://localhost:38000/callback` (only bound during `npm run login`, so it doesn't clash with Claude Code unless both log in at once).

One-time setup:

1. `npm install`
2. Put the app's Consumer Key in `.env` as `SF_CLIENT_ID`.
3. Store the Consumer Secret in the Keychain (hidden prompt, asked twice):
   ```bash
   security add-generic-password -s sf-whatsapp-copilot -a sf-client-secret -w
   ```
4. `npm run login` opens Salesforce in the browser; the refresh token is saved to the Keychain (`sf-whatsapp-copilot` / `sf-refresh-token`). Access tokens stay in memory.

Use:

```bash
npm run tools
```

```bash
npm run ask -- "show me 3 account names"
```

`npm run logout` revokes the token at Salesforce and deletes it from the Keychain. `npm test` runs offline (fake MCP server, throwaway Keychain item).

Guards in [src/agent.js](src/agent.js): only the six SObject Reads tools are offered; one tool call per message; arguments are checked against each tool's schema; `soqlQuery` must be a single `SELECT` and gets `LIMIT 20` when it has none; plain `find` text is wrapped as SOSL `FIND {…}`; misspelled tool names (`soql_query`) map only onto allowed tools.

Known limit: the 4B model sometimes writes SOQL with wrong field names (e.g. `Stage` for `StageName`) and then misreports the error.

## Cost guardrails

- **Salesforce:** only SObject Reads is active. Watch Setup for any Flex Credits or consumption notices.
- **WhatsApp:** 1,000 free replies/month per business number. Do **not** add a payment method; Meta then stops delivering instead of billing. Reply only within the 24-hour window, never send templates.
