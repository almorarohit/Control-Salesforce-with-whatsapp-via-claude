// Long-polling loop: no public URL or tunnel needed; the Mac only connects out to Telegram.

// Only private-chat text messages become inbox messages.
export function toInboxMessage(update) {
  const m = update.message;
  if (!m || m.chat?.type !== 'private' || typeof m.text !== 'string' || !m.from) return undefined;
  return { id: `tg-${update.update_id}`, from: String(m.from.id), chatId: m.chat.id, messageId: m.message_id, text: m.text, timestamp: m.date };
}

const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export function createPoller({ api, inbox, log = console.log, sleep = realSleep, timeoutSec = 50, maxBackoffMs = 60_000 }) {
  let offset;

  async function pollOnce(signal) {
    const updates = await api.getUpdates({ offset, timeout: timeoutSec }, { signal });
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = toInboxMessage(u);
      if (msg) inbox.accept(msg);
      else log(`ignored update …${String(u.update_id).slice(-6)} (not a private text message)`);
    }
    return updates.length;
  }

  async function run(signal) {
    let backoff = 1000;
    while (!signal?.aborted) {
      try {
        await pollOnce(signal);
        backoff = 1000;
      } catch (err) {
        if (signal?.aborted) break;
        if (err.code === 401) throw new Error('Telegram rejected the bot token (401). Store a new one: npm run store-secret -- tg-bot-token');
        const wait = err.retryAfter ? err.retryAfter * 1000 : backoff;
        log(`${err.code === 409 ? 'conflict: another poller or a webhook is active' : 'poll error'} — ${err.message}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
    }
  }

  return { pollOnce, run };
}
