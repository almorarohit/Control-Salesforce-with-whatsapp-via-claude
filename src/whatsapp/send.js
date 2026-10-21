export const MAX_TEXT = 4096;

// Markdown from the model → WhatsApp formatting (*bold*, _italic_; no headings).
export function toWhatsAppText(md) {
  return String(md)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ');
}

// Free-form text reply through the Cloud API. Only valid inside the 24-hour
// customer-service window, which holds because we only ever reply to inbound messages.
export function createWhatsAppSender({ graphVersion, phoneNumberId, getToken, fetchFn = fetch }) {
  return async function sendText(to, body, replyToId) {
    const formatted = toWhatsAppText(body);
    const text = formatted.length > MAX_TEXT ? `${formatted.slice(0, MAX_TEXT - 1)}…` : formatted;
    const res = await fetchFn(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
        ...(replyToId && { context: { message_id: replyToId } }),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}): ${data.error?.message || 'unknown error'}`);
    return data.messages?.[0]?.id;
  };
}
