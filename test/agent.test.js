import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTools, guardSoql, validateArgs, runAgent, toSosl, resolveTool } from '../src/agent.js';

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
