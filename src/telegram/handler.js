import { sendReply } from './format.js';
import { NotLoggedInError } from '../sfAuth.js';

export const HELP_TEXT = `Hi! I answer read-only questions about your Salesforce org.

Try:
• show me 3 account names
• which Salesforce user am I connected as?
• what fields does the Opportunity object have?
• find the contact Rose Gonzalez

I can't create, change or delete records. Replies take 15–60 seconds.`;

const TYPING_EVERY_MS = 4000; // Telegram shows "typing…" for ~5s per call

// Handles one allowlisted message: commands locally, everything else through the agent.
export function createTelegramHandler({ api, answer, log = console.log, typingEveryMs = TYPING_EVERY_MS }) {
  return async function onMessage(msg) {
    const text = msg.text.trim();
    if (/^\/(start|help)\b/i.test(text)) return sendReply(api, msg.chatId, HELP_TEXT, msg.messageId);

    const typing = () => api.sendTyping(msg.chatId).catch(() => {});
    typing();
    const timer = setInterval(typing, typingEveryMs);
    let reply;
    try {
      const result = await answer(text);
      if (result.toolCall) log(`tool ${result.toolCall.name}${result.error ? ` blocked: ${result.error}` : ''}`);
      reply = result.reply || 'Sorry, I had no answer for that.';
    } catch (err) {
      log(`agent error: ${err.message}`);
      reply = err instanceof NotLoggedInError ? 'My Salesforce login has expired. Run `npm run login` on the Mac.' : 'Sorry, something went wrong on my side. Is Ollama running on the Mac?';
    } finally {
      clearInterval(timer);
    }
    await sendReply(api, msg.chatId, reply, msg.messageId);
  };
}
