// Channel-independent intake: sender allowlist, at-most-once dedupe, stale filter,
// and a one-at-a-time queue (one model run at a time fits 8 GB of RAM).
// Messages are { id, from, text, timestamp } with timestamp in seconds.

export const MAX_AGE_MS = 5 * 60 * 1000;

export const mask = (n) => `…${String(n).slice(-4)}`;
export const shortId = (id) => `…${String(id).slice(-8)}`;

export function createInbox({ isAllowed, seen, onMessage, log = console.log, now = Date.now, maxAgeMs = MAX_AGE_MS }) {
  let queue = Promise.resolve();
  const accepting = new Set();

  async function intake(msg) {
    if (!isAllowed(msg)) return log(`ignored message ${shortId(msg.id)} from non-allowlisted ${mask(msg.from)}`);
    if (!(await seen.claim(String(msg.id)))) return log(`duplicate ${shortId(msg.id)} skipped`);
    if (now() - msg.timestamp * 1000 > maxAgeMs) return log(`stale ${shortId(msg.id)} skipped`);
    queue = queue.then(async () => {
      const t0 = now();
      try {
        await onMessage(msg);
        log(`handled ${shortId(msg.id)} in ${((now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        log(`failed ${shortId(msg.id)}: ${err.message}`);
      }
    });
  }

  function accept(msg) {
    const p = intake(msg).catch((err) => log(`accept failed ${shortId(msg.id)}: ${err.message}`));
    accepting.add(p);
    p.finally(() => accepting.delete(p));
    return p;
  }

  // Resolves once every accepted message has been handled.
  async function idle() {
    while (accepting.size) await Promise.all(accepting);
    await queue;
  }

  return { accept, idle };
}
