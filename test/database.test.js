import test from 'node:test';
import assert from 'node:assert/strict';
import { SnippetDatabase } from '../src/database.js';

function sample(overrides = {}) {
  return {
    title: 'SSH helpers',
    category: 'Infrastructure',
    tags: ['linux', 'ssh'],
    blocks: [
      { id: 'heading-1', type: 'heading', content: 'Connect', level: 2 },
      { id: 'code-1', type: 'code', content: 'ssh home.local', language: 'shell' },
    ],
    ...overrides,
  };
}

test('creates and updates a structured note', () => {
  const database = new SnippetDatabase(':memory:');
  const created = database.createNote(sample());

  assert.equal(created.title, 'SSH helpers');
  assert.equal(created.category, 'Infrastructure');
  assert.deepEqual(created.tags, ['linux', 'ssh']);
  assert.equal(created.blocks[1].type, 'code');

  const updated = database.updateNote(created.id, sample({
    title: 'Remote access',
    tags: ['ssh'],
    versionToken: 'editing-session-1',
  }));
  assert.equal(updated.title, 'Remote access');
  assert.equal(database.listVersions(created.id).length, 1);
  assert.equal(database.listVersions(created.id)[0].title, 'SSH helpers');
  database.close();
});

test('soft deletes, restores, and permanently deletes notes', () => {
  const database = new SnippetDatabase(':memory:');
  const note = database.createNote(sample());

  assert.equal(database.softDelete(note.id), true);
  assert.equal(database.listNotes().length, 0);
  assert.equal(database.listNotes({ deleted: true }).length, 1);
  assert.equal(database.restoreNote(note.id), true);
  assert.equal(database.listNotes().length, 1);

  database.softDelete(note.id);
  assert.equal(database.permanentlyDelete(note.id), true);
  assert.equal(database.getNote(note.id), null);
  database.close();
});

test('retains only the newest 20 versions', () => {
  const database = new SnippetDatabase(':memory:');
  let note = database.createNote(sample());

  for (let index = 0; index < 25; index += 1) {
    note = database.updateNote(note.id, sample({
      title: `Revision ${index}`,
      versionToken: `session-${index}`,
    }));
  }

  const versions = database.listVersions(note.id);
  assert.equal(versions.length, 20);
  assert.equal(versions[0].title, 'Revision 23');
  database.close();
});

test('does not delete a category that is still used by a note', () => {
  const database = new SnippetDatabase(':memory:');
  const note = database.createNote(sample());
  const category = database.listCategories().find((item) => item.name === 'Infrastructure');

  assert.throws(() => database.deleteCategory(category.id), /Move the notes/);
  assert.equal(database.getNote(note.id).category, 'Infrastructure');
  assert.equal(database.listNotes().length, 1);
  database.close();
});

test('deletes an empty category', () => {
  const database = new SnippetDatabase(':memory:');
  const category = database.createCategory('Temporary');
  assert.equal(database.deleteCategory(category.id), true);
  assert.equal(database.listCategories().some((item) => item.name === 'Temporary'), false);
  database.close();
});

test('exports active and deleted notes with categories and version history', () => {
  const database = new SnippetDatabase(':memory:');
  const active = database.createNote(sample());
  database.updateNote(active.id, sample({ title: 'Updated helpers', versionToken: 'backup-version' }));
  const deleted = database.createNote(sample({ title: 'Deleted helper', category: 'Archive', tags: ['old'] }));
  database.softDelete(deleted.id);

  const backup = database.exportBackup();
  assert.equal(backup.format, 'lambda-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.notes.length, 2);
  assert.equal(backup.notes.find((note) => note.id === active.id).versions.length, 1);
  assert.ok(backup.notes.find((note) => note.id === deleted.id).deletedAt);
  assert.deepEqual(backup.notes.find((note) => note.id === deleted.id).tags, ['old']);
  assert.ok(backup.categories.some((category) => category.name === 'Archive'));
  database.close();
});

test('restores a backup by replacing all current data', () => {
  const source = new SnippetDatabase(':memory:');
  const active = source.createNote(sample());
  source.updateNote(active.id, sample({ title: 'Restored helper', versionToken: 'restore-version' }));
  const deleted = source.createNote(sample({ title: 'In the bin', category: 'Archive' }));
  source.softDelete(deleted.id);
  source.createCategory('Empty category');
  const backup = source.exportBackup();

  const target = new SnippetDatabase(':memory:');
  target.createNote(sample({ title: 'Must disappear' }));
  const result = target.restoreBackup(backup);

  assert.deepEqual(result, { notes: 1, trash: 1, categories: 4 });
  assert.equal(target.listNotes()[0].title, 'Restored helper');
  assert.equal(target.listVersions(active.id)[0].title, 'SSH helpers');
  assert.equal(target.listNotes({ deleted: true })[0].title, 'In the bin');
  assert.ok(target.listCategories().some((category) => category.name === 'Empty category'));
  assert.equal(target.listNotes().some((note) => note.title === 'Must disappear'), false);
  source.close();
  target.close();
});
