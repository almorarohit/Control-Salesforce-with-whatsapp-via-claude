export const MAX_TEXT = 4096;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Model Markdown → Telegram HTML (the subset Telegram accepts: <b>, <i>, <code>).
// Everything else is escaped, so model output can't inject markup.
export function toTelegramHtml(md) {
  return escapeHtml(String(md))
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ');
}

// Plain-text fallback: drop Markdown markers instead of showing them.
export function toPlainText(md) {
  return String(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ');
}

export const truncate = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

// Sends formatted when possible; falls back to plain text if too long or Telegram rejects the HTML.
export async function sendReply(api, chatId, text, replyTo) {
  const html = toTelegramHtml(text);
  if (html.length <= MAX_TEXT) {
    try {
      return await api.sendMessage(chatId, html, { replyTo, html: true });
    } catch (err) {
      if (err.code !== 400) throw err;
    }
  }
  return api.sendMessage(chatId, truncate(toPlainText(text)), { replyTo });
}
