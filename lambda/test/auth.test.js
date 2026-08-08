import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthManager } from '../src/auth.js';
import { SnippetDatabase } from '../src/database.js';

function requestWith(token) {
  return {
    headers: { cookie: `snippet_session=${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

test('extends a session whenever it is used', () => {
  const auth = new AuthManager('test password', 30);
  const token = auth.createSession();
  const request = requestWith(token);
  auth.sessions.set(token, Date.now() + 1_000);

  const previousExpiry = auth.sessions.get(token);
  assert.equal(auth.authenticate(request), token);
  assert.ok(auth.sessions.get(token) > previousExpiry);
  assert.match(auth.cookie(token, request), /Max-Age=2592000/);
});

test('rejects an expired session instead of extending it', () => {
  const auth = new AuthManager('test password', 30);
  const token = auth.createSession();
  auth.sessions.set(token, Date.now() - 1);

  assert.equal(auth.authenticate(requestWith(token)), null);
  assert.equal(auth.sessions.has(token), false);
});

test('retains sessions when the database is reopened after a restart', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-session-test-'));
  const filename = path.join(directory, 'snippet.db');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const initialDatabase = new SnippetDatabase(filename);
  const first = new AuthManager('test password', 30, initialDatabase.sessions);
  const token = first.createSession();
  initialDatabase.close();

  const reopenedDatabase = new SnippetDatabase(filename);
  const restarted = new AuthManager('test password', 30, reopenedDatabase.sessions);
  assert.equal(restarted.authenticate(requestWith(token)), token);

  restarted.destroySession(requestWith(token));
  assert.equal(restarted.authenticate(requestWith(token)), null);
  reopenedDatabase.close();
});
