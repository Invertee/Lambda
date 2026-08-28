import { randomUUID } from 'node:crypto';

const BOOKMARK_SELECT = `
  SELECT b.id, b.url, b.title, b.created_at, b.updated_at, b.deleted_at,
         COALESCE((
           SELECT json_group_array(t.name)
           FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
           WHERE bt.bookmark_id = b.id
         ), '[]') AS tags_json
  FROM bookmarks b
`;

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export class BookmarkStore {
  constructor(db, encryption = null) {
    this.db = db;
    this.encryption = encryption;
  }

  encode(id, field, value) { return this.encryption ? this.encryption.encryptText(value, `lambda:bookmark:${id}:${field}:v1`) : value; }
  decode(id, field, value) { return this.encryption ? this.encryption.decryptText(value, `lambda:bookmark:${id}:${field}:v1`) : value; }

  fromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      url: this.decode(row.id, 'url', row.url),
      title: this.decode(row.id, 'title', row.title),
      tags: parseJson(row.tags_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at || null,
    };
  }

  listBookmarks({ tag = '', search = '', includeDeleted = false, deletedOnly = false } = {}) {
    const tagKey = String(tag).trim().toLocaleLowerCase();
    const searchKey = String(search).trim().toLocaleLowerCase();
    const deletedClause = deletedOnly ? 'WHERE b.deleted_at IS NOT NULL' : includeDeleted ? '' : 'WHERE b.deleted_at IS NULL';
    const order = deletedOnly ? 'ORDER BY b.deleted_at DESC, b.updated_at DESC' : 'ORDER BY b.updated_at DESC';
    return this.db.prepare(`${BOOKMARK_SELECT} ${deletedClause} ${order}`).all().map((row) => this.fromRow(row)).filter((bookmark) => {
      if (tagKey && !bookmark.tags.some((item) => item.toLocaleLowerCase() === tagKey)) return false;
      return !searchKey || [bookmark.title, bookmark.url, ...bookmark.tags].join(' ').toLocaleLowerCase().includes(searchKey);
    });
  }

  getBookmark(id, { includeDeleted = false } = {}) {
    const deletedClause = includeDeleted ? '' : ' AND b.deleted_at IS NULL';
    return this.fromRow(this.db.prepare(`${BOOKMARK_SELECT} WHERE b.id = ?${deletedClause}`).get(id));
  }

  setTags(bookmarkId, tags) {
    this.db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').run(bookmarkId);
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    const getTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
    const linkTag = this.db.prepare('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)');
    for (const tag of tags) { insertTag.run(tag); linkTag.run(bookmarkId, getTag.get(tag).id); }
    this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags UNION SELECT DISTINCT tag_id FROM bookmark_tags)');
  }

  createBookmark({ url, title, tags }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO bookmarks (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, this.encode(id, 'url', url), this.encode(id, 'title', title), now, now);
      this.setTags(id, tags);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getBookmark(id);
  }

  updateBookmark(id, { url, title, tags }) {
    if (!this.getBookmark(id)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE bookmarks SET url = ?, title = ?, updated_at = ? WHERE id = ?')
        .run(this.encode(id, 'url', url), this.encode(id, 'title', title), new Date().toISOString(), id);
      this.setTags(id, tags);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getBookmark(id);
  }

  deleteBookmark(id) {
    const now = new Date().toISOString();
    return this.db.prepare('UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id).changes > 0;
  }

  restoreBookmark(id) {
    return this.db.prepare('UPDATE bookmarks SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(new Date().toISOString(), id).changes > 0;
  }

  permanentlyDeleteBookmark(id) {
    return this.db.prepare('DELETE FROM bookmarks WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
  }

  exportBackup() { return this.listBookmarks({ includeDeleted: true }); }

  restoreBackup(bookmarks = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM bookmark_tags; DELETE FROM bookmarks;');
      const insert = this.db.prepare('INSERT INTO bookmarks (id, url, title, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const bookmark of bookmarks) {
        insert.run(bookmark.id, this.encode(bookmark.id, 'url', bookmark.url), this.encode(bookmark.id, 'title', bookmark.title), bookmark.createdAt, bookmark.updatedAt, bookmark.deletedAt || null);
        this.setTags(bookmark.id, bookmark.tags);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { bookmarks: this.listBookmarks().length };
  }
}
