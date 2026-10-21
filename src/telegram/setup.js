// Helpers for linking the owner's Telegram account (scripts/telegram-setup.mjs).

// The first private-chat /start among the updates, if any.
export function findStarter(updates) {
  for (const u of updates) {
    const m = u.message;
    if (m?.chat?.type === 'private' && m.from && !m.from.is_bot && /^\/start\b/.test(m.text || '')) {
      return { updateId: u.update_id, userId: String(m.from.id), chatId: m.chat.id, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username };
    }
  }
  return undefined;
}

// Set KEY=value in .env text, replacing an existing line or appending one.
export function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
}
