// Minimal Ollama /api/chat client (thinking off, deterministic, 4K context to fit 8 GB RAM).
export function createOllamaChat({ host, model }) {
  return async function chat(messages, tools) {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, think: false, options: { temperature: 0, num_ctx: 4096 } }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    return (await res.json()).message;
  };
}
