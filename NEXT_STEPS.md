# Next steps for you

Everything that could be built and tested without your Telegram account is done (see README → "Telegram bot"). These steps need you. About 5 minutes.

## 1. Create the bot (Telegram app on your phone)

1. Open a chat with **@BotFather** (blue check mark) → send `/newbot`.
2. Pick a display name (e.g. `SF Copilot`) and a username ending in `bot` (e.g. `rohit_sf_copilot_bot`). Usernames can't be changed later.
3. BotFather replies with a token like `123456789:AA…`. Tap it to copy. Don't paste it anywhere else.

## 2. On the Mac, in the project folder

Store the token from your clipboard (prints only its length):

```bash
cd ~/sf-whatsapp-assistant && npm run store-secret -- tg-bot-token
```

Link your Telegram account (waits up to 5 minutes; open the `t.me/…` link it prints and tap **Start**):

```bash
npm run telegram:setup
```

Make sure Ollama is running (it was running inside the Claude session, which may have ended). Either open **Ollama.app** once, or run this in its own terminal:

```bash
ollama serve
```

Start the bot:

```bash
npm run bot
```

Then message your bot: `show me 3 account names`. Replies take 10–60 seconds; you'll see "typing…" meanwhile.

## 3. Optional

- **Keep it running in the background** (starts Ollama + bot at login, restarts on crash): `scripts/launchd.sh install`. Undo with `scripts/launchd.sh uninstall`. Nothing runs while the Mac sleeps.
- **Free ~1.1 GB** of leftover Homebrew downloads from the abandoned Ollama source build: `brew cleanup`.
- **WhatsApp leftovers** (only if you're dropping WhatsApp for good):
  - Meta: App settings → Advanced → clear **Authorize callback URL** (it was entered there by mistake).
  - Keychain items no longer needed: `wa-access-token` (expired anyway), `wa-app-secret`, `wa-verify-token` under service `sf-whatsapp-copilot`.
  - `ngrok` isn't needed for Telegram: `brew uninstall --cask ngrok`.
- **Salesforce:** the unused `http://localhost:38001/callback` on the External Client App can be removed.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `npm run bot` says the token was rejected (401) | Copy the token again from BotFather (`/mybots` → your bot → API Token) and rerun `npm run store-secret -- tg-bot-token` |
| Bot replies "Is Ollama running on the Mac?" | Start `ollama serve` (or open Ollama.app) |
| Bot replies "My Salesforce login has expired" | `npm run login` |
| No reply at all | Check the `npm run bot` terminal; only the linked Telegram account gets replies |
| "conflict: another poller…" in the log | Another `npm run bot` is already running; stop one |
