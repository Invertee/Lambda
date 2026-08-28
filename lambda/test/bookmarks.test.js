import test from 'node:test';
import assert from 'node:assert/strict';
import { SnippetDatabase } from '../src/database.js';
import { BookmarkStore } from '../src/bookmark-store.js';
import { createApp } from '../src/server.js';

test('bookmarks share tags with notes and retain editable metadata', () => {
  const database = new SnippetDatabase(':memory:');
  const bookmarks = new BookmarkStore(database.db);
  const note = database.createNote({ title: 'Design note', category: 'General', tags: ['research'], blocks: [] });
  const bookmark = bookmarks.createBookmark({ url: 'https://example.com/article', title: 'Example article', tags: ['Research', 'web'] });

  assert.deepEqual(bookmarks.listBookmarks({ tag: 'research' }).map((item) => item.id), [bookmark.id]);
  const updated = bookmarks.updateBookmark(bookmark.id, { url: bookmark.url, title: 'Edited title', tags: ['web'] });
  assert.equal(updated.title, 'Edited title');
  assert.equal(database.getNote(note.id).tags[0], 'research');
  assert.equal(bookmarks.deleteBookmark(bookmark.id), true);
  assert.equal(bookmarks.listBookmarks().length, 0);
  assert.equal(bookmarks.listBookmarks({ deletedOnly: true })[0].deletedAt !== null, true);
  assert.equal(bookmarks.restoreBookmark(bookmark.id), true);
  assert.equal(bookmarks.listBookmarks()[0].id, bookmark.id);
  assert.equal(bookmarks.deleteBookmark(bookmark.id), true);
  assert.equal(bookmarks.permanentlyDeleteBookmark(bookmark.id), true);
  assert.equal(bookmarks.listBookmarks({ deletedOnly: true }).length, 0);
  assert.deepEqual(database.listNotes({ tag: 'research' }).map((item) => item.id), [note.id]);
  database.close();
});

test('bookmark API fetches a title and includes bookmarks in backups', async (context) => {
  const database = new SnippetDatabase(':memory:');
  const app = createApp({ database, password: 'bookmarks password', host: '127.0.0.1', port: 0, bookmarkTitleFetcher: async () => 'Fetched page title' });
  await app.listen();
  context.after(async () => { await app.close(); database.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bookmarks password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${base}/api/bookmarks`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'https://example.com/docs', tags: ['docs'] }) });
  assert.equal(created.status, 201);
  const bookmark = await created.json();
  assert.equal(bookmark.title, 'Fetched page title');
  const updated = await fetch(`${base}/api/bookmarks/${bookmark.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'A better title', tags: ['reference'] }) }).then((response) => response.json());
  assert.equal(updated.title, 'A better title');
  assert.deepEqual(updated.tags, ['reference']);
  const backup = await fetch(`${base}/api/backup`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(backup.bookmarks.length, 1);
  assert.equal(backup.bookmarks[0].title, 'A better title');
  assert.equal((await fetch(`${base}/api/bookmarks/${bookmark.id}`, { method: 'DELETE', headers: { cookie } })).status, 204);
  const trash = await fetch(`${base}/api/bookmarks?trash=1`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(trash[0].id, bookmark.id);
  assert.equal((await fetch(`${base}/api/bookmarks/${bookmark.id}/restore`, { method: 'POST', headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/bookmarks`, { headers: { cookie } }).then((response) => response.json())).length, 1);
  await fetch(`${base}/api/bookmarks/${bookmark.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal((await fetch(`${base}/api/bookmarks/${bookmark.id}/permanent`, { method: 'DELETE', headers: { cookie } })).status, 204);
  const restored = await fetch(`${base}/api/backup`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(backup) });
  assert.equal(restored.status, 200);
  const afterRestore = await fetch(`${base}/api/bookmarks`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(afterRestore[0].title, 'A better title');
});

test('bookmark API saves the URL when title fetching fails', async (context) => {
  const database = new SnippetDatabase(':memory:');
  const app = createApp({
    database,
    password: 'bookmark fallback password',
    host: '127.0.0.1',
    port: 0,
    bookmarkTitleFetcher: async () => { throw new Error('Network unavailable.'); },
  });
  await app.listen();
  context.after(async () => { await app.close(); database.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'bookmark fallback password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/bookmarks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url: 'https://makerworld.com/en/models/2571932-design-lamp', tags: ['design'] }),
  });

  assert.equal(response.status, 201);
  const bookmark = await response.json();
  assert.equal(bookmark.url, 'https://makerworld.com/en/models/2571932-design-lamp');
  assert.equal(bookmark.title, 'makerworld.com');
  assert.deepEqual(bookmark.tags, ['design']);
});
