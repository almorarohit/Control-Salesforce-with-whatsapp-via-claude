// Minimal Telegram Bot API client. The token only ever appears in the request URL,
// never in errors or logs.
export const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(method, code, description, retryAfter) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTelegramApi({ getToken, fetchFn = fetch, base = TELEGRAM_API }) {
  async function call(method, params = {}, { signal } = {}) {
    let res;
    try {
      res = await fetchFn(`${base}/bot${await getToken()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new TelegramError(method, 'network', err.cause?.code || err.message);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new TelegramError(method, data.error_code || res.status, data.description || 'unknown error', data.parameters?.retry_after);
    return data.result;
  }

  return {
    call,
    getMe: () => call('getMe'),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),
    // Long polling: waits up to `timeout` seconds for new updates. Passing offset confirms earlier ones.
    getUpdates: ({ offset, timeout = 50 } = {}, opts) => call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, opts),
    sendMessage: (chatId, text, { replyTo, html } = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        ...(html && { parse_mode: 'HTML' }),
        link_preview_options: { is_disabled: true },
        ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
      }),
    sendTyping: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }),
  };
}
