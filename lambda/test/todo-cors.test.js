import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';
import { enableTodoCors } from '../src/todo-cors.js';

test('allows authenticated browser access to the todo API', async (context) => {
  const database = new SnippetDatabase(':memory:');
  const app = enableTodoCors(createApp({
    database,
    apiKey: 'test-key',
    password: 'test-password',
    host: '127.0.0.1',
    port: 0,
  }));
  await app.listen();
  context.after(async () => {
    await app.close();
    database.close();
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const origin = 'https://start.example.test';

  const preflight = await fetch(`${base}/api/todos`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

  const response = await fetch(`${base}/api/todos`, {
    headers: { origin, authorization: 'Bearer test-key' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await response.json(), []);
});
