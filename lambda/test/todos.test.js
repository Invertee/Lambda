import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';
import { processMcpMessage } from '../src/mcp.js';
import { TodoStore } from '../src/todo-store.js';
import { validateTodo } from '../src/validation.js';

test('todo storage lists active items by default and keeps completed items separate', () => {
  const database = new SnippetDatabase(':memory:');
  const todos = new TodoStore(database.db);

  const active = todos.createTodo(validateTodo({
    title: 'Active task',
    dueDate: '2026-08-21',
    subtasks: ['First step', 'Second step'],
  }));
  const finished = todos.createTodo(validateTodo({ title: 'Finished task', subtasks: [] }));
  todos.updateTodo(finished.id, validateTodo({
    title: finished.title,
    dueDate: finished.dueDate,
    subtasks: finished.subtasks,
    completed: true,
  }));

  assert.equal(todos.listTodos().length, 1);
  assert.equal(todos.listTodos()[0].id, active.id);
  assert.equal(todos.listTodos({ completedOnly: true }).length, 1);
  assert.equal(todos.listTodos({ includeCompleted: true }).length, 2);
  assert.equal(active.subtasks.length, 2);
  assert.equal(active.dueDate, '2026-08-21');

  database.close();
});

test('todo REST API defaults to active items and can clear completed history', async (context) => {
  const database = new SnippetDatabase(':memory:');
  const todos = new TodoStore(database.db);
  const app = createApp({
    database,
    todos,
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

  const created = await fetch(`${base}/api/todos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Review tenant',
      dueDate: '2026-08-22',
      subtasks: [{ title: 'Export configuration' }],
    }),
  }).then((response) => response.json());
  assert.equal(created.completed, false);
  assert.equal(created.subtasks[0].title, 'Export configuration');

  const completed = await fetch(`${base}/api/todos/${created.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ completed: true }),
  }).then((response) => response.json());
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);

  const active = await fetch(`${base}/api/todos`, { headers }).then((response) => response.json());
  assert.equal(active.length, 0);

  const all = await fetch(`${base}/api/todos?include_completed=1`, { headers }).then((response) => response.json());
  assert.equal(all.length, 1);

  const cleared = await fetch(`${base}/api/todos/completed`, { method: 'DELETE', headers }).then((response) => response.json());
  assert.equal(cleared.deleted, 1);
  assert.equal((await fetch(`${base}/api/todos?include_completed=1`, { headers }).then((response) => response.json())).length, 0);
});

test('MCP exposes todo tools and defaults list_todos to active tasks', () => {
  const database = new SnippetDatabase(':memory:');
  const todos = new TodoStore(database.db);
  todos.createTodo(validateTodo({ title: 'MCP active', subtasks: [] }));
  const done = todos.createTodo(validateTodo({ title: 'MCP done', subtasks: [] }));
  todos.updateTodo(done.id, validateTodo({ title: done.title, subtasks: [], completed: true }));

  const listedTools = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }, todos);
  assert.ok(listedTools.body.result.tools.some((tool) => tool.name === 'list_todos'));
  assert.ok(listedTools.body.result.tools.some((tool) => tool.name === 'clear_completed_todos'));

  const active = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_todos', arguments: {} },
  }, todos);
  assert.equal(active.body.result.structuredContent.result.length, 1);
  assert.equal(active.body.result.structuredContent.result[0].title, 'MCP active');

  const completed = processMcpMessage(database, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_todos', arguments: { completed_only: true } },
  }, todos);
  assert.equal(completed.body.result.structuredContent.result.length, 1);
  assert.equal(completed.body.result.structuredContent.result[0].title, 'MCP done');

  database.close();
});
