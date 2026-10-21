#!/usr/bin/env node
// Phase 2: offline tool-calling check for a local Ollama model.
// Tools are stubs named after the Salesforce SObject Reads MCP tools; nothing
// leaves this machine. Usage: node scripts/ollama-tool-test.mjs [model]

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || 'qwen3:4b';

const SYSTEM = `You are a Salesforce assistant reached over WhatsApp.
You can only READ data, using the provided tools. Call at most one tool per message.
If the user asks to create, update or delete anything, do not call a tool; say you are read-only.
If no tool is needed, answer directly. Keep replies short.`;

const tools = [
  {
    name: 'soqlQuery',
    description: 'Run a read-only SOQL query against the Salesforce org.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A SOQL SELECT statement' } }, required: ['query'] },
    validate: (a) => typeof a.query === 'string' && /^\s*select\s/i.test(a.query) && /\bfrom\s+\w+/i.test(a.query),
    stub: () => ({ totalSize: 3, records: [{ Name: 'Edge Communications' }, { Name: 'Burlington Textiles Corp of America' }, { Name: 'Pyramid Construction Inc.' }] }),
  },
  {
    name: 'find',
    description: 'Full-text search across Salesforce records for a search term.',
    parameters: { type: 'object', properties: { searchTerm: { type: 'string' }, objectName: { type: 'string', description: 'Optional SObject to limit the search, e.g. Contact' } }, required: ['searchTerm'] },
    validate: (a) => typeof a.searchTerm === 'string' && a.searchTerm.trim().length > 0,
    stub: () => ({ results: [{ type: 'Contact', Name: 'Jane Smith', Email: 'jane.smith@example.com' }] }),
  },
  {
    name: 'getObjectSchema',
    description: 'Describe the fields of a Salesforce object (SObject).',
    parameters: { type: 'object', properties: { objectName: { type: 'string', description: 'API name, e.g. Account' } }, required: ['objectName'] },
    validate: (a) => typeof a.objectName === 'string' && /^\w+$/.test(a.objectName),
    stub: (a) => ({ name: a.objectName, fields: ['Id', 'Name', 'StageName', 'Amount', 'CloseDate'] }),
  },
  {
    name: 'getUserInfo',
    description: 'Get the currently connected Salesforce user.',
    parameters: { type: 'object', properties: {} },
    validate: () => true,
    stub: () => ({ username: 'user@example.com', profile: 'System Administrator' }),
  },
  {
    name: 'listRecentSobjectRecords',
    description: 'List recently viewed records of a given object.',
    parameters: { type: 'object', properties: { objectName: { type: 'string' } }, required: ['objectName'] },
    validate: (a) => typeof a.objectName === 'string' && /^\w+$/.test(a.objectName),
    stub: () => ({ records: [{ Name: 'Grand Hotels & Resorts Ltd' }] }),
  },
];
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const toolDefs = tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));

// expect: tool name(s) acceptable, or null for "no tool call".
const cases = [
  { prompt: 'Show me 3 account names', expect: ['soqlQuery'], check: (a) => /from\s+account/i.test(a.query) },
  { prompt: 'What fields does the Opportunity object have?', expect: ['getObjectSchema'], check: (a) => /^opportunity$/i.test(a.objectName) },
  { prompt: 'Find the contact Jane Smith', expect: ['find', 'soqlQuery'] },
  { prompt: 'Which Salesforce user am I connected as?', expect: ['getUserInfo'] },
  { prompt: 'Which accounts did I look at recently?', expect: ['listRecentSobjectRecords', 'soqlQuery'] },
  { prompt: 'Hi! What can you do?', expect: null },
  { prompt: 'Create a new account called Acme Corp', expect: null },
  { prompt: 'Delete the account Edge Communications', expect: null },
];

async function chat(messages, withTools = true) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools: withTools ? toolDefs : undefined, stream: false, think: false, options: { temperature: 0, num_ctx: 4096 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message;
}

const short = (s, n = 100) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

let passed = 0;
for (const c of cases) {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: c.prompt }];
  const reply = await chat(messages);
  const calls = reply.tool_calls || [];
  let ok, detail, final = reply.content;

  if (c.expect === null) {
    ok = calls.length === 0;
    detail = ok ? 'no tool call' : `unexpected call ${calls.map((x) => x.function.name).join(', ')}`;
  } else if (calls.length !== 1) {
    ok = false;
    detail = calls.length ? `${calls.length} tool calls (want 1)` : 'no tool call';
  } else {
    const { name, arguments: args = {} } = calls[0].function;
    const tool = byName[name];
    const valid = !!tool && tool.validate(args);
    ok = c.expect.includes(name) && valid && (!c.check || c.check(args));
    detail = `${name}(${JSON.stringify(args)})${valid ? '' : ' [invalid args]'}`;
    if (tool && valid) {
      messages.push(reply, { role: 'tool', tool_name: name, content: JSON.stringify(tool.stub(args)) });
      final = (await chat(messages, false)).content;
    }
  }

  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${((Date.now() - t0) / 1000).toFixed(1)}s  "${c.prompt}"\n      ${detail}\n      reply: ${short(final)}`);
}
console.log(`\n${MODEL}: ${passed}/${cases.length} passed`);
process.exitCode = passed === cases.length ? 0 : 1;
