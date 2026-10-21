import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTools, guardSoql, validateArgs, runAgent, toSosl, resolveTool, compactSchema, soqlObject, isWriteRequest, READ_ONLY_REPLY } from '../src/agent.js';

const soqlTool = { name: 'soqlQuery', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
const schemaTool = { name: 'getObjectSchema', inputSchema: { type: 'object', properties: { objectName: { type: 'string' } }, required: ['objectName'] } };

test('allowedTools keeps only read tools', () => {
  const names = allowedTools([{ name: 'soqlQuery' }, { name: 'createRecord' }, { name: 'deleteRecord' }, { name: 'find' }]).map((t) => t.name);
  assert.deepEqual(names, ['soqlQuery', 'find']);
});

test('guardSoql adds a LIMIT, keeps an existing one, rejects non-SELECT and stacked queries', () => {
  assert.equal(guardSoql('SELECT Id FROM Account'), 'SELECT Id FROM Account LIMIT 20');
  assert.equal(guardSoql('select Id from Account limit 5;'), 'select Id from Account limit 5');
  assert.equal(guardSoql('SELECT Id FROM Account LIMIT 5 OFFSET 10'), 'SELECT Id FROM Account LIMIT 5 OFFSET 10');
  assert.throws(() => guardSoql('DELETE FROM Account'), /Only SELECT/);
  assert.throws(() => guardSoql('SELECT Id FROM Account; SELECT Id FROM Contact'), /one query/);
});

test('validateArgs enforces required, known and typed arguments', () => {
  assert.deepEqual(validateArgs(schemaTool, { objectName: 'Account' }), { objectName: 'Account' });
  assert.throws(() => validateArgs(schemaTool, {}), /Missing required/);
  assert.throws(() => validateArgs(schemaTool, { objectName: 'Account', extra: 1 }), /Unknown argument/);
  assert.throws(() => validateArgs(schemaTool, { objectName: 3 }), /should be string/);
  assert.deepEqual(validateArgs(soqlTool, { query: 'SELECT Name FROM Account' }), { query: 'SELECT Name FROM Account LIMIT 20' });
});

test('validateArgs guards the real SObject Reads soqlQuery argument `q`', () => {
  const realSoql = { name: 'soqlQuery', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
  assert.deepEqual(validateArgs(realSoql, { q: 'SELECT Id FROM Account' }), { q: 'SELECT Id FROM Account LIMIT 20' });
  assert.throws(() => validateArgs(realSoql, { q: 'DELETE FROM Account' }), /Only SELECT/);
  assert.throws(() => validateArgs(realSoql, {}), /needs a query/);
});

test('toSosl wraps plain text, escapes reserved characters, keeps real FIND clauses', () => {
  assert.equal(toSosl('Rose Gonzalez'), 'FIND {Rose Gonzalez}');
  assert.equal(toSosl('"Acme"'), 'FIND {Acme}');
  assert.equal(toSosl("O'Brien & Co"), "FIND {O\\'Brien \\& Co}");
  assert.equal(toSosl('FIND {Joe} IN NAME FIELDS'), 'FIND {Joe} IN NAME FIELDS');
});

test('resolveTool maps case/underscore variants only onto allowed tools', () => {
  const tools = [{ name: 'soqlQuery' }, { name: 'getUserInfo' }];
  assert.equal(resolveTool(tools, 'soql_query').name, 'soqlQuery');
  assert.equal(resolveTool(tools, 'GET_USER_INFO').name, 'getUserInfo');
  assert.equal(resolveTool(tools, 'deleteRecord'), undefined);
});

const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] });

test('runAgent answers directly when no tool is called', async () => {
  const r = await runAgent({ prompt: 'hi', tools: [soqlTool], chat: async () => ({ content: 'hello' }), callTool: assert.fail });
  assert.deepEqual(r, { reply: 'hello' });
});

test('runAgent runs one validated tool call and returns the final reply', async () => {
  const seen = [];
  const replies = [call('soqlQuery', { query: 'SELECT Name FROM Account' }), { content: 'Here are your accounts' }];
  const r = await runAgent({
    prompt: 'show accounts',
    tools: [soqlTool],
    chat: async (messages, tools) => (seen.push({ messages: [...messages], tools }), replies.shift()),
    callTool: async (name, args) => `called ${name} ${args.query}`,
  });
  assert.equal(r.reply, 'Here are your accounts');
  assert.deepEqual(r.toolCall, { name: 'soqlQuery', args: { query: 'SELECT Name FROM Account LIMIT 20' } });
  assert.equal(seen[1].tools, undefined, 'second turn has no tools');
  assert.equal(seen[1].messages.at(-1).content, 'called soqlQuery SELECT Name FROM Account LIMIT 20');
});

test('runAgent blocks disallowed tools, bad args and multiple calls without calling Salesforce', async () => {
  const cases = [
    call('deleteRecord', { id: '001' }),
    call('soqlQuery', { query: 'DELETE FROM Account' }),
    { content: '', tool_calls: [call('find', {}).tool_calls[0], call('find', {}).tool_calls[0]] },
  ];
  for (const reply of cases) {
    const r = await runAgent({ prompt: 'x', tools: [soqlTool], chat: async () => reply, callTool: assert.fail });
    assert.ok(r.error, `expected block for ${JSON.stringify(reply.tool_calls)}`);
  }
});

test('guardSoql leaves aggregates without GROUP BY unlimited (LIMIT would cap COUNT())', () => {
  assert.equal(guardSoql('SELECT COUNT() FROM Opportunity WHERE IsClosed = false'), 'SELECT COUNT() FROM Opportunity WHERE IsClosed = false');
  assert.equal(guardSoql('SELECT SUM(Amount) FROM Opportunity'), 'SELECT SUM(Amount) FROM Opportunity');
  assert.equal(guardSoql('SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName'), 'SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName LIMIT 20');
});

test('compactSchema reduces describe output to field names, types and picklist values', () => {
  const raw = JSON.stringify({ details: [{ name: 'Opportunity', childRelationships: [{ childObject: 'X' }], fields: [{ name: 'Id', type: 'id' }, { name: 'StageName', type: 'picklist', picklistValues: [{ value: 'Prospecting', active: true }, { value: 'Old', active: false }, { value: 'Closed Won', active: true }] }] }] });
  assert.equal(compactSchema(raw), 'Opportunity fields: Id (id), StageName (picklist: Prospecting | Closed Won)');
  assert.equal(compactSchema(JSON.stringify({ details: [], index: { objects: [{ name: 'Account' }, { name: 'Lead' }] } })), 'Objects: Account, Lead');
  assert.equal(compactSchema('not json'), 'not json');
  assert.equal(soqlObject('select Id from Opportunity where x'), 'Opportunity');
});

test('runAgent compacts getObjectSchema results before the model sees them', async () => {
  const schemaTool = { name: 'getObjectSchema', inputSchema: { type: 'object', properties: { objects: { type: 'string' } } } };
  const seen = [];
  const replies = [call('getObjectSchema', { objects: 'Opportunity' }), { content: 'done' }];
  await runAgent({
    prompt: 'fields?',
    tools: [schemaTool],
    chat: async (messages) => (seen.push(messages.at(-1).content), replies.shift()),
    callTool: async () => JSON.stringify({ details: [{ name: 'Opportunity', childRelationships: [], fields: [{ name: 'Amount', type: 'currency' }] }] }),
  });
  assert.equal(seen[1], 'Opportunity fields: Amount (currency)');
});

test('runAgent retries a SOQL query once with real field names after INVALID_FIELD', async () => {
  const realSoql = { name: 'soqlQuery', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
  const schemaTool = { name: 'getObjectSchema', inputSchema: { type: 'object', properties: { objects: { type: 'string' } } } };
  const toolCalls = [];
  const offered = [];
  const replies = [
    call('soqlQuery', { q: "SELECT COUNT() FROM Opportunity WHERE Stage = 'Open'" }),
    call('soqlQuery', { q: 'SELECT COUNT() FROM Opportunity WHERE IsClosed = false' }),
    { content: 'There are 13 open opportunities.' },
  ];
  const r = await runAgent({
    prompt: 'how many open opportunities?',
    tools: [realSoql, schemaTool],
    chat: async (messages, tools) => (offered.push(tools?.map((t) => t.function.name)), replies.shift()),
    callTool: async (name, args) => {
      toolCalls.push([name, args]);
      if (name === 'getObjectSchema') return JSON.stringify({ details: [{ name: 'Opportunity', fields: [{ name: 'IsClosed', type: 'boolean' }] }] });
      if (/Stage =/.test(args.q)) return 'Tool error: [{"message":"No such column \'Stage\' on entity \'Opportunity\'","errorCode":"INVALID_FIELD"}]';
      return '{"totalSize":13,"done":true,"records":[]}';
    },
  });
  assert.equal(r.reply, 'There are 13 open opportunities.');
  assert.equal(r.retried, true);
  assert.deepEqual(toolCalls.map(([n]) => n), ['soqlQuery', 'getObjectSchema', 'soqlQuery']);
  assert.deepEqual(offered, [['soqlQuery', 'getObjectSchema'], ['soqlQuery'], undefined], 'retry offers only soqlQuery; final turn offers no tools');
});

test('runAgent does not retry non-SOQL errors or more than once', async () => {
  const realSoql = { name: 'soqlQuery', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
  let n = 0;
  const replies = [call('soqlQuery', { q: 'SELECT Bad FROM Account' }), call('soqlQuery', { q: 'SELECT Bad2 FROM Account' }), { content: 'sorry' }];
  const r = await runAgent({
    prompt: 'x',
    tools: [realSoql],
    chat: async () => replies.shift(),
    callTool: async () => (n++, 'Tool error: [{"errorCode":"INVALID_FIELD"}]'),
  });
  assert.equal(r.reply, 'sorry');
  assert.equal(n, 2, 'original + one retry only');
});

test('write requests get the read-only reply without the model or Salesforce', async () => {
  for (const p of ['delete the account Edge Communications', 'Please update Acme phone', 'can you create a lead', 'Close the Burlington opportunity']) {
    assert.equal(isWriteRequest(p), true, p);
    assert.deepEqual(await runAgent({ prompt: p, tools: [], chat: assert.fail, callTool: assert.fail }), { reply: READ_ONLY_REPLY });
  }
  for (const p of ['show accounts created this week', 'which opportunities close this month?', 'what changed recently?']) assert.equal(isWriteRequest(p), false, p);
});
