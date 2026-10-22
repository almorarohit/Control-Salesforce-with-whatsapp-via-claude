import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTools, guardSoql, validateArgs, runAgent, toSosl, resolveTool, compactSchema, soqlObject, isWriteRequest, READ_ONLY_REPLY, errorSummary, suggestObject } from '../src/agent.js';

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

const BAD_OBJECT = 'Tool error: [{"message":"\\nEnabled__c FROM ConnectedApp WHERE x\\n   ^\\nERROR at Row:1:Column:58\\nsObject type \'ConnectedApp\' is not supported. If you are attempting to use a custom object, be sure to append the \'__c\' after the entity name.","errorCode":"INVALID_TYPE"}]';

test('errorSummary turns Salesforce tool errors into one readable sentence', () => {
  assert.equal(errorSummary(BAD_OBJECT), "sObject type 'ConnectedApp' is not supported.");
  assert.equal(errorSummary('Tool error: [{"message":"\\nSELECT Id, Stage FROM Opportunity\\n ^\\nERROR at Row:1:Column:12\\nNo such column \'Stage\' on entity \'Opportunity\'. If you are attempting to use a custom field, be sure…","errorCode":"INVALID_FIELD"}]'), "No such column 'Stage' on entity 'Opportunity'.");
  assert.equal(errorSummary('Tool error: plain text failure'), 'plain text failure');
});

test('suggestObject maps wrong object names to real ones', () => {
  assert.equal(suggestObject('ConnectedApp'), 'ConnectedApplication');
  assert.equal(suggestObject('ConnectedApp__c'), 'ConnectedApplication');
  assert.equal(suggestObject('External_Client_App'), 'ExternalClientApplication');
  assert.equal(suggestObject('accounts', ['Account', 'Contact']), 'Account');
  assert.equal(suggestObject('opportunity', ['Opportunity']), 'Opportunity');
  assert.equal(suggestObject('Spaceship', ['Account']), undefined);
});

const realSoql = { name: 'soqlQuery', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
const describe = { name: 'getObjectSchema', inputSchema: { type: 'object', properties: { objects: { type: 'string' } } } };

test('wrong object name: retry hint names the real object and its fields', async () => {
  const prompts = [];
  const replies = [
    call('soqlQuery', { q: 'SELECT Id, Enabled__c FROM ConnectedApp' }),
    call('soqlQuery', { q: 'SELECT Name, OptionsAllowAdminApprovedUsersOnly FROM ConnectedApplication' }),
    { content: 'Dataloader Bulk: admin approval not required' },
  ];
  const r = await runAgent({
    prompt: 'list connected apps',
    tools: [realSoql, describe],
    chat: async (messages) => (prompts.push(messages.at(-1)), replies.shift()),
    callTool: async (name, args) => {
      if (name === 'getObjectSchema' && !args.objects) return JSON.stringify({ details: [], index: { objects: [{ name: 'Account' }] } });
      if (name === 'getObjectSchema') return JSON.stringify({ details: [{ name: args.objects, fields: [{ name: 'OptionsAllowAdminApprovedUsersOnly', type: 'boolean' }] }] });
      return /FROM ConnectedApp\b(?!lication)/.test(args.q) ? BAD_OBJECT : '{"totalSize":1,"records":[{"Name":"Dataloader Bulk","OptionsAllowAdminApprovedUsersOnly":false}]}';
    },
  });
  assert.equal(r.reply, 'Dataloader Bulk: admin approval not required');
  assert.match(prompts[1].content, /There is no object "ConnectedApp"; use ConnectedApplication/);
  assert.match(prompts[1].content, /OptionsAllowAdminApprovedUsersOnly \(boolean\)/);
});

test('unknown object: hint lists queryable objects including setup objects', async () => {
  const prompts = [];
  const replies = [call('soqlQuery', { q: 'SELECT Id FROM Spaceship' }), { content: '' }, { content: 'no such thing' }];
  await runAgent({
    prompt: 'spaceships?',
    tools: [realSoql, describe],
    chat: async (messages) => (prompts.push(messages.at(-1).content), replies.shift()),
    callTool: async (name, args) => (name === 'getObjectSchema' ? JSON.stringify({ details: [], index: { objects: [{ name: 'Account' }] } }) : BAD_OBJECT.replace(/ConnectedApp/g, 'Spaceship')),
  });
  assert.match(prompts[1], /Objects you can query: Account, ConnectedApplication, ExternalClientApplication/);
});

test('empty final answer after a failed query reports the Salesforce error, not "no answer"', async () => {
  const replies = [call('soqlQuery', { q: 'SELECT Id FROM ConnectedApp' }), call('soqlQuery', { q: 'SELECT Id FROM ConnectedApp__c' }), { content: '  ' }];
  const r = await runAgent({
    prompt: 'connected apps?',
    tools: [realSoql],
    chat: async () => replies.shift(),
    callTool: async () => BAD_OBJECT,
  });
  assert.equal(r.reply, "I couldn't get that from Salesforce: sObject type 'ConnectedApp' is not supported.");
  assert.equal(r.error, "sObject type 'ConnectedApp' is not supported.");
});

test('empty final answer after a successful query keeps the generic fallback', async () => {
  const replies = [call('soqlQuery', { q: 'SELECT Id FROM Account' }), { content: '' }];
  const r = await runAgent({ prompt: 'x', tools: [realSoql], chat: async () => replies.shift(), callTool: async () => '{"records":[]}' });
  assert.equal(r.reply, 'Sorry, I had no answer for that.');
});

const multi = (...cs) => ({ role: 'assistant', content: '', tool_calls: cs.map(([name, args]) => ({ function: { name, arguments: args } })) });

test('two tool calls for a two-part question both run; a third is dropped', async () => {
  const ran = [];
  const seen = [];
  const replies = [
    multi(['soqlQuery', { q: 'SELECT Name FROM ConnectedApplication' }], ['soqlQuery', { q: 'SELECT MasterLabel FROM ExternalClientApplication' }], ['soqlQuery', { q: 'SELECT Id FROM Account' }]),
    { content: 'both answered' },
  ];
  const r = await runAgent({
    prompt: 'connected apps and external client apps',
    tools: [realSoql],
    chat: async (messages) => (seen.push(messages.slice()), replies.shift()),
    callTool: async (name, args) => (ran.push(args.q), '{"records":[]}'),
  });
  assert.equal(r.reply, 'both answered');
  assert.deepEqual(ran, ['SELECT Name FROM ConnectedApplication LIMIT 20', 'SELECT MasterLabel FROM ExternalClientApplication LIMIT 20']);
  assert.equal(r.toolCalls.length, 2);
  const last = seen[1];
  assert.equal(last.filter((m) => m.role === 'tool').length, 2);
  assert.equal(last.find((m) => m.role === 'assistant').tool_calls.length, 2);
});

test('one bad call among two blocks the turn before anything runs', async () => {
  const r = await runAgent({
    prompt: 'x',
    tools: [realSoql],
    chat: async () => multi(['soqlQuery', { q: 'SELECT Id FROM Account' }], ['deleteRecord', { id: '001' }]),
    callTool: assert.fail,
  });
  assert.match(r.error, /Tool not allowed: deleteRecord/);
});

test('with two calls, one failing is not reported as a total failure', async () => {
  const replies = [multi(['soqlQuery', { q: 'SELECT Id FROM Account' }], ['soqlQuery', { q: 'SELECT Id FROM Contact' }]), { content: '' }];
  const r = await runAgent({
    prompt: 'x',
    tools: [realSoql],
    chat: async () => replies.shift(),
    callTool: async (n, a) => (/Contact/.test(a.q) ? 'Tool error: [{"message":"denied","errorCode":"INSUFFICIENT_ACCESS"}]' : '{"records":[]}'),
  });
  assert.equal(r.reply, 'Sorry, I had no answer for that.');
  assert.equal(r.error, undefined);
});
