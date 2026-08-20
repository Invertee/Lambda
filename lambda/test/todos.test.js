import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';
import { TodoStore } from '../src/todo-store.js';
import { validateTodo } from '../src/validation.js';

test('todo storage lists active items by priority and keeps completed items separate', () => {
  const database = new SnippetDatabase(':memory:');
  const todos = new TodoStore(database.db);

  const first = todos.createTodo(validateTodo({
    title: 'First task',
    dueDate: '2026-08-21',
    subtasks: ['First step', 'Second step'],
  }));
  const second = todos.createTodo(validateTodo({ title: 'Second task', subtasks: [] }));

  assert.equal(first.priority, 1);
  assert.equal(second.priority, 2);
  assert.equal(todos.countActive(), 2);

  const reordered = todos.reorderActive([second.id, first.id]);
  assert.deepEqual(reordered.map((todo) => todo.id), [second.id, first.id]);
  assert.deepEqual(reordered.map((todo) => todo.priority), [1, 2]);

  const finished = todos.updateTodo(second.id, validateTodo({
    title: second.title,
    dueDate: second.dueDate,
    subtasks: second.subtasks,
    completed: true,
  }));
  assert.equal(finished.completed, true);
  assert.equal(todos.countActive(), 1);
  assert.equal(todos.listTodos()[0].id, first.id);

  const reopened = todos.updateTodo(second.id, validateTodo({
    title: second.title,
    dueDate: second.dueDate,
    subtasks: second.subtasks,
    completed: false,
  }));
  assert.equal(reopened.priority, 3);
  assert.deepEqual(todos.listTodos().map((todo) => todo.id), [first.id, second.id]);
  assert.equal(first.subtasks.length, 2);
  assert.equal(first.dueDate, '2026-08-21');

  database.close();
});

test('todo REST API defaults to active items, exposes count, reorders priority, and clears completed history', async (context) => {
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

  const first = await fetch(`${base}/api/todos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Review tenant',
      dueDate: '2026-08-22',
      subtasks: [{ title: 'Export configuration' }],
    }),
  }).then((response) => response.json());
  const second = await fetch(`${base}/api/todos`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Check migration', subtasks: [] }),
  }).then((response) => response.json());

  assert.equal(first.completed, false);
  assert.equal(first.subtasks[0].title, 'Export configuration');
  assert.equal(first.priority, 1);
  assert.equal(second.priority, 2);

  const count = await fetch(`${base}/api/todos/count`, { headers }).then((response) => response.json());
  assert.equal(count.active, 2);

  const reorderedResponse = await fetch(`${base}/api/todos/order`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ids: [second.id, first.id] }),
  });
  assert.equal(reorderedResponse.status, 200);
  const reordered = await reorderedResponse.json();
  assert.deepEqual(reordered.map((todo) => todo.id), [second.id, first.id]);
  assert.deepEqual(reordered.map((todo) => todo.priority), [1, 2]);

  const completed = await fetch(`${base}/api/todos/${second.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ completed: true }),
  }).then((response) => response.json());
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);

  const active = await fetch(`${base}/api/todos`, { headers }).then((response) => response.json());
  assert.equal(active.length, 1);
  assert.equal(active[0].id, first.id);

  const all = await fetch(`${base}/api/todos?include_completed=1`, { headers }).then((response) => response.json());
  assert.equal(all.length, 2);

  const staleOrder = await fetch(`${base}/api/todos/order`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ids: [second.id, first.id] }),
  });
  assert.equal(staleOrder.status, 409);

  const cleared = await fetch(`${base}/api/todos/completed`, { method: 'DELETE', headers }).then((response) => response.json());
  assert.equal(cleared.deleted, 1);
  assert.equal((await fetch(`${base}/api/todos?include_completed=1`, { headers }).then((response) => response.json())).length, 1);
});
