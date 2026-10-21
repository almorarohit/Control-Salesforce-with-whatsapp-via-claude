// Read-only Salesforce agent: one model turn, at most one tool call, arguments
// checked by the backend before anything reaches Salesforce.

export const READ_TOOLS = new Set(['soqlQuery', 'find', 'getObjectSchema', 'getUserInfo', 'getRelatedRecords', 'listRecentSobjectRecords']);
export const DEFAULT_SOQL_LIMIT = 20;
const MAX_RESULT_CHARS = 4000;

export const SYSTEM_PROMPT = `You are a Salesforce assistant reached over WhatsApp.
You can only READ data, using the provided tools. Call at most one tool per message.
If the user asks to create, update or delete anything, do not call a tool; say you are read-only.
If no tool is needed, answer directly. Keep replies short.`;

export function allowedTools(mcpTools) {
  return mcpTools.filter((t) => READ_TOOLS.has(t.name));
}

export function toOllamaTools(mcpTools) {
  return mcpTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
}

// Single SELECT only; adds a LIMIT when missing so a vague question can't pull the whole org.
export function guardSoql(query) {
  const q = String(query).trim().replace(/;\s*$/, '');
  if (!/^select\s/i.test(q)) throw new Error('Only SELECT queries are allowed');
  if (q.includes(';')) throw new Error('Only one query is allowed');
  return /\blimit\s+\d+\s*$/i.test(q) || /\blimit\s+\d+\s+offset\s+\d+\s*$/i.test(q) ? q : `${q} LIMIT ${DEFAULT_SOQL_LIMIT}`;
}

// Plain search text becomes a SOSL FIND clause; reserved characters are escaped.
export function toSosl(text) {
  const t = String(text).trim();
  if (/^find\s*\{/i.test(t)) return t;
  return `FIND {${t.replace(/^["{]+|["}]+$/g, '').replace(/[?&|!{}[\]()^~*:\\"'+-]/g, '\\$&')}}`;
}

// Small models sometimes emit soql_query / SOQLQuery; map those to the real allowlisted name.
const normalizeName = (n) => String(n).toLowerCase().replace(/[^a-z]/g, '');
export function resolveTool(tools, name) {
  return tools.find((t) => t.name === name) || tools.find((t) => normalizeName(t.name) === normalizeName(name));
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// Shallow check against the tool's JSON Schema; returns the (possibly rewritten) args.
export function validateArgs(tool, args) {
  if (!TYPE_CHECKS.object(args)) throw new Error('Arguments must be an object');
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  for (const name of schema.required || []) {
    if (args[name] === undefined || args[name] === '') throw new Error(`Missing required argument: ${name}`);
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = props[name];
    if (!prop) throw new Error(`Unknown argument: ${name}`);
    const types = [].concat(prop.type || []);
    if (types.length && !types.some((t) => TYPE_CHECKS[t]?.(value))) throw new Error(`Argument ${name} should be ${types.join(' or ')}`);
  }
  if (tool.name === 'find' && typeof args.q === 'string') return { ...args, q: toSosl(args.q) };
  if (tool.name !== 'soqlQuery') return args;
  const queryKey = Object.keys(args).find((k) => /^(q|query|soql)$/i.test(k));
  if (!queryKey) throw new Error('soqlQuery needs a query argument');
  return { ...args, [queryKey]: guardSoql(args[queryKey]) };
}

// Returns { reply, toolCall?, error? }. `chat(messages, tools)` and `callTool(name, args)` are injected.
export async function runAgent({ prompt, tools, chat, callTool }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
  const first = await chat(messages, toOllamaTools(tools));
  const calls = first.tool_calls || [];
  if (calls.length === 0) return { reply: first.content };

  const { name: rawName, arguments: rawArgs = {} } = calls[0].function;
  const tool = resolveTool(tools, rawName);
  const name = tool?.name || rawName;
  let args;
  try {
    if (calls.length > 1) throw new Error('Only one tool call per message is allowed');
    if (!tool) throw new Error(`Tool not allowed: ${name}`);
    args = validateArgs(tool, rawArgs);
  } catch (err) {
    return { reply: `Sorry, I couldn't run that safely (${err.message}). Try rephrasing.`, toolCall: { name, args: rawArgs }, error: err.message };
  }

  const output = await callTool(name, args);
  const content = output.length > MAX_RESULT_CHARS ? `${output.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : output;
  const call = { ...calls[0], function: { ...calls[0].function, name, arguments: args } };
  messages.push({ role: 'assistant', content: first.content || '', tool_calls: [call] }, { role: 'tool', tool_name: name, content });
  const final = await chat(messages);
  return { reply: final.content, toolCall: { name, args } };
}
