import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';

async function startApp(context) {
  const database = new SnippetDatabase(':memory:');
  const app = createApp({
    database,
    password: 'browser-password',
    apiKey: 'automation-secret',
    host: '127.0.0.1',
    port: 0,
  });
  await app.listen();
  context.after(async () => {
    await app.close();
    database.close();
  });
  return { app, database, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('static API key supports create, partial update, filtering, and category rename', async (context) => {
  const { base } = await startApp(context);
  const headers = { authorization: 'Bearer automation-secret', 'content-type': 'application/json' };

  const rejected = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejected.status, 401);

  const createdResponse = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Automation note',
      category: 'Tests',
      tags: ['one'],
      blocks: [{ type: 'text', content: 'Created by PowerShell' }],
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const patchedResponse = await fetch(`${base}/api/notes/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ title: 'Renamed by automation' }),
  });
  assert.equal(patchedResponse.status, 200);
  const patched = await patchedResponse.json();
  assert.equal(patched.title, 'Renamed by automation');
  assert.equal(patched.category, 'Tests');
  assert.deepEqual(patched.tags, ['one']);
  assert.equal(patched.blocks[0].content, 'Created by PowerShell');

  const filtered = await fetch(`${base}/api/notes?category=tests&tag=ONE&q=powershell`, { headers })
    .then((response) => response.json());
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, created.id);

  const categories = await fetch(`${base}/api/categories`, { headers }).then((response) => response.json());
  const testsCategory = categories.find((category) => category.name === 'Tests');
  const renamedResponse = await fetch(`${base}/api/categories/${testsCategory.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: 'Automation' }),
  });
  assert.equal(renamedResponse.status, 200);
  const noteAfterRename = await fetch(`${base}/api/notes/${created.id}`, { headers }).then((response) => response.json());
  assert.equal(noteAfterRename.category, 'Automation');
});

test('MCP endpoint exposes and executes note, todo, and category tools', async (context) => {
  const { base } = await startApp(context);
  const callMcp = async (method, params = {}) => {
    const headers = {
      authorization: 'Bearer automation-secret',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    };
    if (method === 'tools/call') headers['mcp-name'] = params.name;
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-1`, method, params }),
    });
  };

  const anonymous = await fetch(`${base}/mcp`, { method: 'POST' });
  assert.equal(anonymous.status, 401);

  const discovered = await callMcp('server/discover');
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json()).result.supportedVersions[0], '2026-07-28');

  const listed = await callMcp('tools/list');
  const listedPayload = (await listed.json()).result;
  assert.equal(listedPayload.resultType, 'complete');
  assert.equal(listedPayload._meta['io.modelcontextprotocol/serverInfo'].version, '1.3.0');
  assert.ok(listedPayload.tools.some((tool) => tool.name === 'create_note'));
  assert.ok(listedPayload.tools.some((tool) => tool.name === 'create_todo'));
  assert.ok(listedPayload.tools.some((tool) => tool.name === 'rename_category'));

  const todoResponse = await callMcp('tools/call', {
    name: 'create_todo',
    arguments: {
      title: 'MCP task',
      due_date: '2026-08-22',
      subtasks: [{ title: 'First step' }],
    },
  });
  const todoPayload = await todoResponse.json();
  assert.equal(todoPayload.result.isError, false);
  assert.equal(todoPayload.result.structuredContent.result.title, 'MCP task');

  const createdResponse = await callMcp('tools/call', {
    name: 'create_note',
    arguments: {
      title: 'MCP note',
      category: 'Agents',
      tags: ['mcp'],
      content_type: 'code',
      language: 'powershell',
      content: 'Get-Date',
    },
  });
  const createdPayload = await createdResponse.json();
  assert.equal(createdPayload.result.isError, false);
  const created = createdPayload.result.structuredContent.result;
  assert.equal(created.blocks[0].language, 'powershell');

  const updatedResponse = await callMcp('tools/call', {
    name: 'update_note',
    arguments: { id: created.id, title: 'Updated MCP note' },
  });
  const updated = (await updatedResponse.json()).result.structuredContent.result;
  assert.equal(updated.title, 'Updated MCP note');
  assert.equal(updated.blocks[0].content, 'Get-Date');

  const notesResponse = await callMcp('tools/call', {
    name: 'list_notes',
    arguments: { category: 'agents', query: 'Get-Date' },
  });
  const notes = (await notesResponse.json()).result.structuredContent.result;
  assert.equal(notes.length, 1);

  const legacy = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer automation-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).result.protocolVersion, '2025-06-18');
});
