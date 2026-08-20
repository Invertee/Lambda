import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptionVault } from '../src/encryption.js';
import { SnippetDatabase } from '../src/database.js';
import { TodoStore } from '../src/todo-store.js';

test('persists a password-wrapped data key and encrypts authenticated data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-encryption-'));
  const keyPath = path.join(dir, 'snippet.db.encryption.json');
  try {
    const first = new EncryptionVault('correct horse battery staple', keyPath);
    const one = first.encryptText('secret note', 'test-context');
    const two = first.encryptText('secret note', 'test-context');
    assert.notEqual(one, two);
    assert.doesNotMatch(one, /secret note/);
    assert.equal(first.decryptText(one, 'test-context'), 'secret note');
    assert.throws(() => first.decryptText(one, 'wrong-context'));

    const second = new EncryptionVault('correct horse battery staple', keyPath);
    assert.equal(second.decryptText(one, 'test-context'), 'secret note');
    assert.throws(() => new EncryptionVault('wrong password', keyPath), /could not be unlocked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stores note and version content encrypted in SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-database-encryption-'));
  const dbPath = path.join(dir, 'snippet.db');
  try {
    const vault = new EncryptionVault('app password', `${dbPath}.encryption.json`);
    const database = new SnippetDatabase(dbPath, vault);
    const note = database.createNote({
      title: 'Secret title',
      category: 'Infrastructure',
      tags: ['private'],
      blocks: [{ id: 'one', type: 'text', content: 'Secret body' }],
    });
    database.updateNote(note.id, {
      title: 'Updated title',
      category: 'Infrastructure',
      tags: ['private'],
      blocks: [{ id: 'one', type: 'text', content: 'Updated body' }],
      versionToken: 'version-one',
    });

    const storedNote = database.db.prepare('SELECT title, blocks_json FROM notes WHERE id = ?').get(note.id);
    const storedVersion = database.db.prepare('SELECT title, blocks_json FROM versions WHERE note_id = ?').get(note.id);
    assert.doesNotMatch(storedNote.title, /Secret|Updated/);
    assert.doesNotMatch(storedNote.blocks_json, /body/i);
    assert.doesNotMatch(storedVersion.title, /Secret|Updated/);
    assert.doesNotMatch(storedVersion.blocks_json, /body/i);
    assert.equal(database.getNote(note.id).title, 'Updated title');
    assert.equal(database.listVersions(note.id)[0].title, 'Secret title');
    database.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stores todo titles and subtasks encrypted in SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-todo-encryption-'));
  const dbPath = path.join(dir, 'snippet.db');
  try {
    const vault = new EncryptionVault('todo password', `${dbPath}.encryption.json`);
    const database = new SnippetDatabase(dbPath, vault);
    const todos = new TodoStore(database.db, vault);
    const todo = todos.createTodo({
      title: 'Secret task title',
      dueDate: '2026-08-22',
      subtasks: [{ id: 'step-one', title: 'Secret task step', completed: false }],
      completed: false,
    });

    const stored = database.db.prepare('SELECT title, due_date, subtasks_json FROM todos WHERE id = ?').get(todo.id);
    assert.doesNotMatch(stored.title, /Secret task title/);
    assert.doesNotMatch(stored.subtasks_json, /Secret task step/);
    assert.equal(stored.due_date, '2026-08-22');
    assert.equal(todos.getTodo(todo.id).title, 'Secret task title');
    assert.equal(todos.getTodo(todo.id).subtasks[0].title, 'Secret task step');
    database.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('encrypts binary attachment data without retaining plaintext', () => {
  const vault = new EncryptionVault('password');
  const source = Buffer.from('Get-ChildItem');
  const encrypted = vault.encryptBytes(source, 'lambda:attachment:test:v1');
  assert.equal(encrypted.includes(source), false);
  assert.deepEqual(vault.decryptBytes(encrypted, 'lambda:attachment:test:v1'), source);
});
