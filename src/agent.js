// Read-only Salesforce agent: one model turn, up to two tool calls (plus one retry for a
// fixable SOQL error), arguments checked by the backend before anything reaches Salesforce.

export const READ_TOOLS = new Set(['soqlQuery', 'find', 'getObjectSchema', 'getUserInfo', 'getRelatedRecords', 'listRecentSobjectRecords']);
export const DEFAULT_SOQL_LIMIT = 20;
const MAX_RESULT_CHARS = 4000;
const MAX_SCHEMA_FIELDS = 120;

export const SYSTEM_PROMPT = `You are a Salesforce assistant reached over chat.
You can only READ data, using the provided tools. Call one tool per message, or two when the question has two parts.
If the user asks to create, update, delete, assign or otherwise change anything, do NOT call any tool, not even to look the record up; just reply that you are read-only.
SOQL tips: use API field names (e.g. Opportunity.StageName, Opportunity.IsClosed, Opportunity.Amount). To count records use SELECT COUNT() FROM ... and read totalSize from the result. "Open" opportunities are IsClosed = false.
Setup objects you can also query: ConnectedApplication (connected apps: Name, OptionsAllowAdminApprovedUsersOnly, OptionsHasSessionLevelPolicy, RefreshTokenValidityPeriod, OptionsRefreshTokenValidityMetric) and ExternalClientApplication (External Client Apps: MasterLabel, DeveloperName, DistributionState).
For OAuth scopes of External Client Apps run exactly: SELECT ExternalClientApplication.MasterLabel, OauthScopesMCP_API, OauthScopesAPI, OauthScopesREFRESH_TOKEN, OauthScopesOFFLINE_ACCESS, OauthScopesFULL, OauthScopesWEB, OauthScopesOPENID, OauthScopesSFAP_API FROM ExtlClntAppOauthSettings
For classic connected apps, OAuth scopes, callback URLs, consumer keys and PKCE settings are metadata and can't be read (External Client App scopes can, with the query above).
If no tool is needed, answer directly. Keep replies short, use bullet lists (never tables), and base them only on tool results.`;

// Setup objects that SOQL accepts even though getObjectSchema's index doesn't list them (checked against the org).
export const SETUP_OBJECTS = ['ConnectedApplication', 'ExternalClientApplication', 'ExtlClntAppOauthSettings', 'OauthToken'];
const OBJECT_ALIASES = {
  connectedapp: 'ConnectedApplication',
  connectedapps: 'ConnectedApplication',
  connectedapplications: 'ConnectedApplication',
  externalclientapp: 'ExternalClientApplication',
  externalclientapps: 'ExternalClientApplication',
  externalclientapplications: 'ExternalClientApplication',
  eca: 'ExternalClientApplication',
  externalclientappoauthsettings: 'ExtlClntAppOauthSettings',
  oauthtokens: 'OauthToken',
};

// Best guess for a wrong object name: known alias, then case/underscore/plural/__c variants of known objects.
export function suggestObject(badName, knownObjects = []) {
  const norm = (s) => String(s).toLowerCase().replace(/__c$/, '').replace(/[^a-z0-9]/g, '');
  const n = norm(badName);
  if (OBJECT_ALIASES[n]) return OBJECT_ALIASES[n];
  const all = [...new Set([...knownObjects, ...SETUP_OBJECTS])];
  return all.find((o) => norm(o) === n) || all.find((o) => `${norm(o)}s` === n);
}

// "Tool error: [{"message": "...", "errorCode": "..."}]" → one readable sentence.
export function errorSummary(output) {
  const raw = String(output).replace(/^Tool error:\s*/, '');
  let msg = raw;
  try {
    const first = [].concat(JSON.parse(raw))[0] || {};
    msg = first.message || first.errorCode || raw;
  } catch {
    /* not JSON: use as-is */
  }
  const line = msg.split('\n').map((l) => l.trim()).find((l) => /not supported|No such column|unexpected|invalid|denied|error/i.test(l) && !/^ERROR at Row/i.test(l)) || msg.trim();
  return line.replace(/\s*If you are attempting to use a custom.*$/i, '').replace(/^.*nested exception is:\s*\S+:\s*/i, '').slice(0, 200);
}

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

export const MAX_TOOL_CALLS = 2;

// Resolve + validate one model tool call. Returns { tool, name, args, call } or { name, rawArgs, error }.
function prepareCall(tools, call) {
  const { name: rawName, arguments: rawArgs = {} } = call.function;
  const tool = resolveTool(tools, rawName);
  const name = tool?.name || rawName;
  try {
    if (!tool) throw new Error(`Tool not allowed: ${name}`);
    return { tool, name, args: validateArgs(tool, rawArgs), call };
  } catch (err) {
    return { name, rawArgs, error: err.message };
  }
}

// Up to MAX_TOOL_CALLS read calls per turn (a two-part question needs two queries); extras are dropped.
const prepareCalls = (tools, calls, max = MAX_TOOL_CALLS) => calls.slice(0, max).map((c) => prepareCall(tools, c));

const blocked = (p) => ({ reply: `Sorry, I couldn't run that safely (${p.error}). Try rephrasing.`, toolCall: { name: p.name, args: p.rawArgs }, error: p.error });

// Requests that start with a change verb get the read-only answer without running the model.
const WRITE_INTENT = /^\s*(please\s+|can you\s+|could you\s+)?(create|add|insert|update|edit|change|set|delete|remove|erase|modify|rename|assign|reassign|convert|merge|mark|close|undelete)\b/i;
export const READ_ONLY_REPLY = "I'm read-only: I can look things up in Salesforce, but I can't create, change or delete records.";
export const isWriteRequest = (prompt) => WRITE_INTENT.test(prompt);

// Returns { reply, toolCall?, error?, retried? }. `chat(messages, tools)` and `callTool(name, args)` are injected.
export async function runAgent({ prompt, tools, chat, callTool }) {
  if (isWriteRequest(prompt)) return { reply: READ_ONLY_REPLY };
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];

  // Runs validated calls in order and records them (one assistant turn, one tool message each).
  async function execute(reply, preps) {
    const outputs = [];
    for (const p of preps) {
      let output = await callTool(p.name, p.args);
      if (p.name === 'getObjectSchema') output = compactSchema(output);
      outputs.push(output);
    }
    const calls = preps.map((p) => ({ ...p.call, function: { ...p.call.function, name: p.name, arguments: p.args } }));
    messages.push({ role: 'assistant', content: reply.content || '', tool_calls: calls }, ...preps.map((p, i) => ({ role: 'tool', tool_name: p.name, content: clip(outputs[i]) })));
    return outputs;
  }

  const first = await chat(messages, toOllamaTools(tools));
  if (!first.tool_calls?.length) return { reply: first.content };
  const preps = prepareCalls(tools, first.tool_calls);
  const bad = preps.find((p) => p.error);
  if (bad) return blocked(bad);
  const outputs = await execute(first, preps);

  // One retry for a SOQL query that failed on a bad object, field or syntax, with a hint built from the org.
  let retried = false;
  const queryKeyOf = (p) => p.name === 'soqlQuery' && Object.keys(p.args).find((k) => /^(q|query|soql)$/i.test(k));
  const i = preps.findIndex((p, j) => queryKeyOf(p) && outputs[j].startsWith('Tool error:') && FIXABLE_SOQL.test(outputs[j]));
  if (i !== -1) {
    const hint = await retryHint(outputs[i], soqlObject(preps[i].args[queryKeyOf(preps[i])]), tools, callTool);
    messages.push({ role: 'user', content: `That query failed: ${errorSummary(outputs[i])}\n${hint}Fix the query and call soqlQuery again.` });
    const soqlOnly = tools.filter((t) => t.name === 'soqlQuery');
    const second = await chat(messages, toOllamaTools(soqlOnly));
    if (second.tool_calls?.length) {
      const [p2] = prepareCalls(soqlOnly, second.tool_calls, 1);
      if (p2.error) return blocked(p2);
      [outputs[i]] = await execute(second, [p2]);
      preps[i] = p2;
      retried = true;
    }
  }

  const final = await chat(messages);
  const firstError = outputs.find((o) => o.startsWith('Tool error:'));
  const failed = outputs.every((o) => o.startsWith('Tool error:'));
  // A small model sometimes returns nothing after a failed call; say what Salesforce reported instead.
  const reply = final.content?.trim() || (failed ? `I couldn't get that from Salesforce: ${errorSummary(firstError)}` : 'Sorry, I had no answer for that.');
  return {
    reply,
    toolCall: { name: preps[0].name, args: preps[0].args },
    ...(preps.length > 1 && { toolCalls: preps.map((p) => ({ name: p.name, args: p.args })) }),
    ...(retried && { retried }),
    ...(failed && { error: errorSummary(firstError) }),
  };
}

// Hint for the retry: the real object when the name was wrong, else the object's real fields.
async function retryHint(output, objectName, tools, callTool) {
  const canDescribe = tools.some((t) => t.name === 'getObjectSchema');
  const badObject = /sObject type '([^']+)' is not supported/i.exec(output)?.[1];
  if (badObject) {
    let known = [];
    if (canDescribe) {
      try {
        known = JSON.parse(await callTool('getObjectSchema', {})).index?.objects?.map((o) => o.name) || [];
      } catch {
        /* index unavailable: fall back to aliases and setup objects */
      }
    }
    const suggestion = suggestObject(badObject, known);
    if (suggestion && canDescribe) {
      const fields = compactSchema(await callTool('getObjectSchema', { objects: suggestion }));
      return `There is no object "${badObject}"; use ${suggestion}.\n${clip(fields)}\n`;
    }
    return `There is no object "${badObject}". Objects you can query: ${[...new Set([...known, ...SETUP_OBJECTS])].join(', ')}.\n`;
  }
  if (objectName && canDescribe) return `Valid ${objectName} fields:\n${clip(compactSchema(await callTool('getObjectSchema', { objects: objectName })))}\n`;
  return '';
}
