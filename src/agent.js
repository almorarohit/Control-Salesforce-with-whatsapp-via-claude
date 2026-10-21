// Read-only Salesforce agent: one model turn, one tool call (plus one retry for a
// fixable SOQL error), arguments checked by the backend before anything reaches Salesforce.

export const READ_TOOLS = new Set(['soqlQuery', 'find', 'getObjectSchema', 'getUserInfo', 'getRelatedRecords', 'listRecentSobjectRecords']);
export const DEFAULT_SOQL_LIMIT = 20;
const MAX_RESULT_CHARS = 4000;
const MAX_SCHEMA_FIELDS = 120;

export const SYSTEM_PROMPT = `You are a Salesforce assistant reached over chat.
You can only READ data, using the provided tools. Call at most one tool per message.
If the user asks to create, update, delete, assign or otherwise change anything, do NOT call any tool, not even to look the record up; just reply that you are read-only.
SOQL tips: use API field names (e.g. Opportunity.StageName, Opportunity.IsClosed, Opportunity.Amount). To count records use SELECT COUNT() FROM ... and read totalSize from the result. "Open" opportunities are IsClosed = false.
If no tool is needed, answer directly. Keep replies short and base them only on tool results.`;

export function allowedTools(mcpTools) {
  return mcpTools.filter((t) => READ_TOOLS.has(t.name));
}

export function toOllamaTools(mcpTools) {
  return mcpTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
}

const isAggregate = (q) => /\b(count|sum|avg|min|max|count_distinct)\s*\(/i.test(q) && !/\bgroup\s+by\b/i.test(q);

// Single SELECT only; adds a LIMIT when missing so a vague question can't pull the whole org.
// Aggregates without GROUP BY return one row, and a LIMIT there could cap COUNT() results.
export function guardSoql(query) {
  const q = String(query).trim().replace(/;\s*$/, '');
  if (!/^select\s/i.test(q)) throw new Error('Only SELECT queries are allowed');
  if (q.includes(';')) throw new Error('Only one query is allowed');
  if (isAggregate(q)) return q;
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

// getObjectSchema returns ~13 KB per object (mostly child relationships); the model only
// needs field API names, types and picklist values.
export function compactSchema(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  if (data.index?.objects && !data.details?.length) return `Objects: ${data.index.objects.map((o) => o.name).join(', ')}`;
  if (!Array.isArray(data.details)) return text;
  return data.details
    .map((o) => {
      const fields = (o.fields || []).slice(0, MAX_SCHEMA_FIELDS).map((f) => {
        const picks = (f.picklistValues || []).filter((p) => p.active !== false).map((p) => p.value).slice(0, 12);
        return `${f.name} (${f.type}${picks.length ? `: ${picks.join(' | ')}` : ''})`;
      });
      return `${o.name} fields: ${fields.join(', ')}`;
    })
    .join('\n');
}

const FIXABLE_SOQL = /INVALID_FIELD|INVALID_TYPE|MALFORMED_QUERY|No such column|unexpected token/i;
export const soqlObject = (q) => /\bfrom\s+(\w+)/i.exec(q)?.[1];

const clip = (s) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : s);

// Resolve + validate one model tool call. Returns { tool, name, args } or { name, rawArgs, error }.
function prepareCall(tools, calls) {
  const { name: rawName, arguments: rawArgs = {} } = calls[0].function;
  const tool = resolveTool(tools, rawName);
  const name = tool?.name || rawName;
  try {
    if (calls.length > 1) throw new Error('Only one tool call per message is allowed');
    if (!tool) throw new Error(`Tool not allowed: ${name}`);
    return { tool, name, args: validateArgs(tool, rawArgs) };
  } catch (err) {
    return { name, rawArgs, error: err.message };
  }
}

const blocked = (p) => ({ reply: `Sorry, I couldn't run that safely (${p.error}). Try rephrasing.`, toolCall: { name: p.name, args: p.rawArgs }, error: p.error });

// Requests that start with a change verb get the read-only answer without running the model.
const WRITE_INTENT = /^\s*(please\s+|can you\s+|could you\s+)?(create|add|insert|update|edit|change|set|delete|remove|erase|modify|rename|assign|reassign|convert|merge|mark|close|undelete)\b/i;
export const READ_ONLY_REPLY = "I'm read-only: I can look things up in Salesforce, but I can't create, change or delete records.";
export const isWriteRequest = (prompt) => WRITE_INTENT.test(prompt);

// Returns { reply, toolCall?, error?, retried? }. `chat(messages, tools)` and `callTool(name, args)` are injected.
export async function runAgent({ prompt, tools, chat, callTool }) {
  if (isWriteRequest(prompt)) return { reply: READ_ONLY_REPLY };
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];

  async function execute(reply, p) {
    let output = await callTool(p.name, p.args);
    if (p.name === 'getObjectSchema') output = compactSchema(output);
    const call = { ...reply.tool_calls[0], function: { ...reply.tool_calls[0].function, name: p.name, arguments: p.args } };
    messages.push({ role: 'assistant', content: reply.content || '', tool_calls: [call] }, { role: 'tool', tool_name: p.name, content: clip(output) });
    return output;
  }

  const first = await chat(messages, toOllamaTools(tools));
  if (!first.tool_calls?.length) return { reply: first.content };
  let p = prepareCall(tools, first.tool_calls);
  if (p.error) return blocked(p);
  const output = await execute(first, p);

  // One retry for a SOQL query that failed on a bad field or syntax, with the real field names as a hint.
  let retried = false;
  const queryKey = p.name === 'soqlQuery' && Object.keys(p.args).find((k) => /^(q|query|soql)$/i.test(k));
  if (queryKey && output.startsWith('Tool error:') && FIXABLE_SOQL.test(output)) {
    const objectName = soqlObject(p.args[queryKey]);
    let hint = '';
    if (objectName && tools.some((t) => t.name === 'getObjectSchema')) {
      hint = compactSchema(await callTool('getObjectSchema', { objects: objectName }));
    }
    messages.push({ role: 'user', content: `That query failed. ${hint ? `Valid ${objectName} fields:\n${clip(hint)}\n` : ''}Fix the query and call soqlQuery again.` });
    const soqlOnly = tools.filter((t) => t.name === 'soqlQuery');
    const second = await chat(messages, toOllamaTools(soqlOnly));
    if (second.tool_calls?.length) {
      const p2 = prepareCall(soqlOnly, second.tool_calls);
      if (p2.error) return blocked(p2);
      await execute(second, p2);
      p = p2;
      retried = true;
    }
  }

  const final = await chat(messages);
  return { reply: final.content, toolCall: { name: p.name, args: p.args }, ...(retried && { retried }) };
}
