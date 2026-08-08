import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { SnippetDatabase } from '../src/database.js';

test('protects note APIs and supports the authenticated note lifecycle', async (context) => {
  const database = new SnippetDatabase(':memory:');
  const attachmentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-attachments-'));
  const app = createApp({
    database,
    attachmentDir,
    password: 'correct horse battery staple',
    host: '127.0.0.1',
    port: 0,
  });
  await app.listen();
  context.after(async () => {
    await app.close();
    database.close();
    fs.rmSync(attachmentDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const anonymous = await fetch(`${base}/api/bootstrap`);
  assert.equal(anonymous.status, 401);

  const badLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const uploaded = await fetch(`${base}/api/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('commands.txt'),
    },
    body: 'Get-ChildItem',
  });
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.headers.get('set-cookie'), /Max-Age=2592000/);
  const attachment = await uploaded.json();
  assert.equal(attachment.name, 'commands.txt');
  assert.equal(fs.existsSync(path.join(attachmentDir, attachment.id)), true);

  const created = await fetch(`${base}/api/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      title: 'API note',
      category: 'Tests',
      tags: ['http'],
      blocks: [
        { id: 'code', type: 'code', content: 'fetch("/health")', language: 'js' },
        { id: 'file', type: 'file', attachmentId: attachment.id, name: attachment.name, size: attachment.size, mime: attachment.mime },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const note = await created.json();

  const removed = await fetch(`${base}/api/notes/${note.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(removed.status, 204);
  const restored = await fetch(`${base}/api/notes/${note.id}/restore`, { method: 'POST', headers: { cookie } });
  assert.equal(restored.status, 200);

  const snapshot = await fetch(`${base}/api/bootstrap`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(snapshot.notes.length, 1);
  assert.equal(snapshot.notes[0].blocks[0].language, 'js');
  assert.equal(snapshot.notes[0].blocks[1].name, 'commands.txt');
  assert.equal(snapshot.trash.length, 0);

  const backupResponse = await fetch(`${base}/api/backup`, { headers: { cookie } });
  assert.equal(backupResponse.status, 200);
  assert.match(backupResponse.headers.get('content-disposition'), /lambda-backup-\d{4}-\d{2}-\d{2}\.json/);
  const backup = await backupResponse.json();
  assert.equal(backup.format, 'lambda-backup');
  assert.equal(backup.notes.length, 1);
  assert.equal(backup.notes[0].blocks[1].attachmentId, attachment.id);

  const extra = database.createNote({ title: 'Remove me', category: 'Tests', tags: [], blocks: [] });
  const importResponse = await fetch(`${base}/api/backup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(backup),
  });
  assert.equal(importResponse.status, 200);
  assert.equal(database.getNote(extra.id), null);
  assert.equal(database.getNote(note.id).title, 'API note');

  const invalidImport = await fetch(`${base}/api/backup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ format: 'something-else', version: 1, notes: [], categories: [] }),
  });
  assert.equal(invalidImport.status, 400);
  assert.equal(database.getNote(note.id).title, 'API note');

  const malformedImport = await fetch(`${base}/api/backup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...backup, notes: [{ ...backup.notes[0], createdAt: 'not-a-date' }] }),
  });
  assert.equal(malformedImport.status, 400);
  assert.equal(database.getNote(note.id).title, 'API note');

  const downloaded = await fetch(`${base}/api/attachments/${attachment.id}?name=commands.txt`, { headers: { cookie } });
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'Get-ChildItem');
  assert.match(downloaded.headers.get('content-disposition'), /commands\.txt/);
});
