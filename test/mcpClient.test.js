import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectMcp, resultText } from '../src/mcpClient.js';
import { allowedTools, runAgent } from '../src/agent.js';

// Fake MCP server with one read tool and one write tool, so no test touches the org.
function fakeServer(received) {
  const tools = [
    { name: 'soqlQuery', description: 'Run SOQL', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'createRecord', description: 'Create', inputSchema: { type: 'object', properties: {} } },
  ];
  return http.createServer(async (req, res) => {
    const mcp = new Server({ name: 'fake-sf', version: '0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      received.push(params);
      return { content: [{ type: 'text', text: JSON.stringify({ records: [{ Name: 'Edge Communications' }] }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
}

test('connectMcp + runAgent: lists tools, filters to reads, calls the server with guarded args', async () => {
  const received = [];
  const server = fakeServer(received);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = await connectMcp({ serverUrl: `http://127.0.0.1:${server.address().port}/mcp` });
  try {
    const { tools } = await client.listTools();
    const reads = allowedTools(tools);
    assert.deepEqual(reads.map((t) => t.name), ['soqlQuery']);

    const replies = [
      { content: '', tool_calls: [{ function: { name: 'soqlQuery', arguments: { query: 'SELECT Name FROM Account' } } }] },
      { content: 'Edge Communications' },
    ];
    const r = await runAgent({
      prompt: 'show accounts',
      tools: reads,
      chat: async () => replies.shift(),
      callTool: async (name, args) => resultText(await client.callTool({ name, arguments: args })),
    });
    assert.equal(r.reply, 'Edge Communications');
    assert.deepEqual(received, [{ name: 'soqlQuery', arguments: { query: 'SELECT Name FROM Account LIMIT 20' } }]);
  } finally {
    await client.close();
    server.close();
  }
});
