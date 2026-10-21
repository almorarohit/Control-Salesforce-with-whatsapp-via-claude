import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // Meta retries for up to 7 days

// File-backed set of processed message IDs, so Meta's retries are skipped even after a restart.
export async function createSeenStore(file, { ttlMs = SEVEN_DAYS_MS, now = Date.now } = {}) {
  let seen = {};
  try {
    seen = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let writing = Promise.resolve();

  async function persist() {
    const cutoff = now() - ttlMs;
    for (const [id, ts] of Object.entries(seen)) if (ts < cutoff) delete seen[id];
    const snapshot = JSON.stringify(seen);
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, snapshot);
      await rename(`${file}.tmp`, file);
    });
    return writing;
  }

  return {
    has: (id) => Object.hasOwn(seen, id),
    // Returns false if already seen; otherwise records it (before processing: at-most-once).
    async claim(id) {
      if (Object.hasOwn(seen, id)) return false;
      seen[id] = now();
      await persist();
      return true;
    },
  };
}
