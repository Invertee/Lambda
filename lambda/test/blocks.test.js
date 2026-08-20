import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';
import { processMcpMessage } from '../src/mcp.js';
import { validateNote } from '../src/validation.js';

test('assigns stable unique five-character codes and updates blocks directly', () => {
  const database = new SnippetDatabase(':memory:');
  const note = database.createNote(validateNote({
    title: 'Block targets',
    category: 'Automation',
    tags: [],
    blocks: [
      { id: 'first', type: 'text', content: 'before' },
      { id: 'second', type: 'csv', content: 'Name,Value\nAlpha,1' },
    ],
  }));

  assert.match(note.blocks[0].code, /^[A-Z0-9]{5}$/);
  assert.match(note.blocks[1].code, /^[A-Z0-9]{5}$/);
  assert.notEqual(note.blocks[0].code, note.blocks[1].code);

  const code = note.blocks[0].code;
  const updated = database.updateBlock(code, { content: 'after' });
  assert.equal(updated.block.content, 'after');
  assert.equal(updated.block.code, code);
  assert.equal(database.getNote(note.id).blocks[0].code, code);
  assert.equal(database.listVersions(note.id).length, 1);

  assert.equal(database.softDelete(note.id), true);
  assert.equal(database.getBlock(code), null);
  assert.equal(database.restoreNote(note.id), true);
  assert.equal(database.getBlock(code).block.code, code);
  database.close();
});

test('MCP gets and updates blocks by code including CSV content', () => {
  const database = new SnippetDatabase(':memory:');
  const note = database.createNote(validateNote({
    title: 'MCP table',
    category: 'Automation',
    tags: [],
    blocks: [{ id: 'table', type: 'csv', content: 'Name,Value\nAlpha,1' }],
  }));
  const code = note.blocks[0].code;

  const getResult = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_block', arguments: { code } },
  });
  assert.equal(getResult.body.result.structuredContent.result.block.content, 'Name,Value\nAlpha,1');

  const updateResult = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'update_block', arguments: { code, type: 'csv', content: 'Name,Value\nBeta,2' } },
  });
  assert.equal(updateResult.body.result.structuredContent.result.block.type, 'csv');
  assert.equal(updateResult.body.result.structuredContent.result.block.content, 'Name,Value\nBeta,2');
  database.close();
});

test('modern MCP discovery and tool listing use the final 2026 response envelope', () => {
  const database = new SnippetDatabase(':memory:');
  const meta = {
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };

  const discovered = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 'discover-1',
    method: 'server/discover',
    params: { _meta: meta },
  });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.result.supportedVersions[0], '2026-07-28');
  assert.equal(discovered.body.result.serverInfo, undefined);
  assert.equal(discovered.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'lambda-notes');

  const listed = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 'tools-1',
    method: 'tools/list',
    params: { _meta: meta },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.resultType, 'complete');
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'create_note'));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'create_todo'));
  assert.equal(listed.body.result._meta['io.modelcontextprotocol/serverInfo'].version, '1.3.0');

  const legacy = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 'legacy-tools',
    method: 'tools/list',
    params: {},
  });
  assert.equal(legacy.body.result.resultType, undefined);
  assert.equal(legacy.body.result._meta, undefined);
  database.close();
});

test('REST block API accepts JSON and raw CSV and serves the enhanced web shell', async (context) => {
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

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { authorization: 'Bearer automation-secret', 'content-type': 'application/json' };
  const created = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'REST block',
      category: 'Automation',
      tags: [],
      blocks: [{ id: 'target', type: 'text', content: 'old' }],
    }),
  }).then((response) => response.json());
  const code = created.blocks[0].code;

  const patched = await fetch(`${base}/api/blocks/${code}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ content: 'new' }),
  }).then((response) => response.json());
  assert.equal(patched.block.content, 'new');

  const csvResponse = await fetch(`${base}/api/blocks/${code}`, {
    method: 'PUT',
    headers: { authorization: 'Bearer automation-secret', 'content-type': 'text/csv; charset=utf-8' },
    body: 'Name,Status\nSpooler,Running',
  });
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.json();
  assert.equal(csv.block.type, 'csv');
  assert.equal(csv.block.content, 'Name,Status\nSpooler,Running');

  const fetched = await fetch(`${base}/api/blocks/${code}`, {
    headers: { authorization: 'Bearer automation-secret' },
  }).then((response) => response.json());
  assert.equal(fetched.block.content, 'Name,Status\nSpooler,Running');

  const shell = await fetch(base).then((response) => response.text());
  assert.match(shell, /block-tools\.css\?v=1\.3\.0/);
  assert.match(shell, /block-tools\.js\?v=1\.3\.0/);
  assert.match(shell, /todo-tools\.css\?v=1\.3\.0/);
  assert.match(shell, /todo-tools\.js\?v=1\.3\.0/);
});
