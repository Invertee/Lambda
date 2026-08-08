import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const NOTE_SELECT = `
  SELECT n.id, n.title, n.blocks_json, n.created_at, n.updated_at, n.deleted_at,
         c.id AS category_id, c.name AS category,
         COALESCE((
           SELECT json_group_array(t.name)
           FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
           WHERE nt.note_id = n.id
         ), '[]') AS tags_json
  FROM notes n
  LEFT JOIN categories c ON c.id = n.category_id
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function noteFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    categoryId: row.category_id ?? null,
    category: row.category ?? null,
    tags: parseJson(row.tags_json, []),
    blocks: parseJson(row.blocks_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function sessionDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

class SqliteSessionStore {
  constructor(db) {
    this.db = db;
  }

  get(token) {
    return this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
      .get(sessionDigest(token))?.expires_at;
  }

  set(token, expiresAt) {
    this.db.prepare(`
      INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at
    `).run(sessionDigest(token), expiresAt);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  delete(token) {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(sessionDigest(token)).changes > 0;
  }

  has(token) {
    return Boolean(this.get(token));
  }
}

export class SnippetDatabase {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.sessions = new SqliteSessionStore(this.db);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        blocks_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE
      );

      CREATE TABLE IF NOT EXISTS note_tags (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        version_key TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        tags_json TEXT NOT NULL,
        blocks_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(note_id, version_key)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_deleted_updated ON notes(deleted_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_versions_note_created ON versions(note_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      INSERT OR IGNORE INTO categories (name, created_at) VALUES ('General', datetime('now'));
      UPDATE notes
      SET category_id = (SELECT id FROM categories WHERE name = 'General' COLLATE NOCASE)
      WHERE category_id IS NULL;
    `);
  }

  close() {
    this.db.close();
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listNotes({ deleted = false, category = '', tag = '', search = '' } = {}) {
    const comparator = deleted ? 'IS NOT NULL' : 'IS NULL';
    const notes = this.db.prepare(`${NOTE_SELECT} WHERE n.deleted_at ${comparator} ORDER BY n.updated_at DESC`)
      .all()
      .map(noteFromRow);
    const categoryKey = String(category).trim().toLocaleLowerCase();
    const tagKey = String(tag).trim().toLocaleLowerCase();
    const searchKey = String(search).trim().toLocaleLowerCase();
    return notes.filter((note) => {
      if (categoryKey && String(note.category || '').toLocaleLowerCase() !== categoryKey) return false;
      if (tagKey && !note.tags.some((item) => item.toLocaleLowerCase() === tagKey)) return false;
      if (searchKey) {
        const searchable = [
          note.title,
          note.category || '',
          ...note.tags,
          ...note.blocks.map((block) => `${block.content || ''} ${block.language || ''} ${block.alt || ''} ${block.name || ''}`),
        ].join(' ').toLocaleLowerCase();
        if (!searchable.includes(searchKey)) return false;
      }
      return true;
    });
  }

  getNote(id) {
    return noteFromRow(this.db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id));
  }

  listCategories() {
    return this.db.prepare(`
      SELECT c.id, c.name, COUNT(n.id) AS note_count
      FROM categories c
      LEFT JOIN notes n ON n.category_id = c.id AND n.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.name COLLATE NOCASE
    `).all().map((row) => ({ id: row.id, name: row.name, noteCount: row.note_count }));
  }

  createCategory(name) {
    const cleaned = name.trim();
    const existing = this.db.prepare('SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE').get(cleaned);
    if (existing) return { id: existing.id, name: existing.name };
    const result = this.db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)').run(cleaned, new Date().toISOString());
    return { id: Number(result.lastInsertRowid), name: cleaned };
  }

  renameCategory(id, name) {
    const category = this.db.prepare('SELECT id, name FROM categories WHERE id = ?').get(id);
    if (!category) return null;
    const cleaned = name.trim();
    const existing = this.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?').get(cleaned, id);
    if (existing) {
      const error = new Error('A category with that name already exists.');
      error.statusCode = 409;
      throw error;
    }
    this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(cleaned, id);
    return { id: category.id, name: cleaned };
  }

  deleteCategory(id) {
    const category = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
    if (!category) return false;
    if (this.db.prepare('SELECT 1 FROM notes WHERE category_id = ? LIMIT 1').get(id)) {
      const error = new Error('Move the notes in this category before deleting it.');
      error.statusCode = 409;
      throw error;
    }
    return this.db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0;
  }

  resolveCategory(name) {
    return this.createCategory(name || 'General').id;
  }

  setTags(noteId, tags) {
    this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    const getTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
    const linkTag = this.db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)');

    for (const tag of tags) {
      insertTag.run(tag);
      linkTag.run(noteId, getTag.get(tag).id);
    }

    this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)');
  }

  createNote({ title, category, tags, blocks }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      const categoryId = this.resolveCategory(category);
      this.db.prepare(`
        INSERT INTO notes (id, title, category_id, blocks_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, title, categoryId, JSON.stringify(blocks), now, now);
      this.setTags(id, tags);
    });
    return this.getNote(id);
  }

  snapshot(note, versionKey) {
    this.db.prepare(`
      INSERT OR IGNORE INTO versions
        (note_id, version_key, title, category, tags_json, blocks_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      note.id,
      versionKey,
      note.title,
      note.category,
      JSON.stringify(note.tags),
      JSON.stringify(note.blocks),
      new Date().toISOString(),
    );
    this.db.prepare(`
      DELETE FROM versions
      WHERE note_id = ? AND id NOT IN (
        SELECT id FROM versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
      )
    `).run(note.id, note.id);
  }

  updateNote(id, { title, category, tags, blocks, versionToken }) {
    const current = this.getNote(id);
    if (!current || current.deletedAt) return null;

    const changed = current.title !== title
      || (current.category || '') !== (category || '')
      || JSON.stringify(current.tags) !== JSON.stringify(tags)
      || JSON.stringify(current.blocks) !== JSON.stringify(blocks);
    if (!changed) return current;

    this.transaction(() => {
      this.snapshot(current, versionToken || randomUUID());
      const categoryId = this.resolveCategory(category);
      this.db.prepare(`
        UPDATE notes SET title = ?, category_id = ?, blocks_json = ?, updated_at = ? WHERE id = ?
      `).run(title, categoryId, JSON.stringify(blocks), new Date().toISOString(), id);
      this.setTags(id, tags);
    });
    return this.getNote(id);
  }

  softDelete(id) {
    const now = new Date().toISOString();
    return this.db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now, now, id).changes > 0;
  }

  restoreNote(id) {
    return this.db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(new Date().toISOString(), id).changes > 0;
  }

  permanentlyDelete(id) {
    return this.db.prepare('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
  }

  listVersions(noteId) {
    return this.db.prepare(`
      SELECT id, title, category, tags_json, blocks_json, created_at
      FROM versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
    `).all(noteId).map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      tags: parseJson(row.tags_json, []),
      blocks: parseJson(row.blocks_json, []),
      createdAt: row.created_at,
    }));
  }

  exportBackup() {
    const notes = [
      ...this.listNotes(),
      ...this.listNotes({ deleted: true }),
    ].map((note) => ({
      ...note,
      versions: this.listVersions(note.id),
    }));

    return {
      format: 'lambda-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: this.listCategories(),
      notes,
    };
  }

  restoreBackup(backup) {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM note_tags;
        DELETE FROM versions;
        DELETE FROM notes;
        DELETE FROM tags;
        DELETE FROM categories;
      `);

      const insertCategory = this.db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)');
      for (const category of backup.categories) insertCategory.run(category.name, new Date().toISOString());
      for (const note of backup.notes) insertCategory.run(note.category, note.createdAt);
      if (!backup.categories.length && !backup.notes.length) insertCategory.run('General', new Date().toISOString());

      const categoryId = this.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE');
      const insertNote = this.db.prepare(`
        INSERT INTO notes (id, title, category_id, blocks_json, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertVersion = this.db.prepare(`
        INSERT INTO versions (note_id, version_key, title, category, tags_json, blocks_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const note of backup.notes) {
        insertNote.run(
          note.id,
          note.title,
          categoryId.get(note.category).id,
          JSON.stringify(note.blocks),
          note.createdAt,
          note.updatedAt,
          note.deletedAt,
        );
        this.setTags(note.id, note.tags);
        note.versions.forEach((version, index) => insertVersion.run(
          note.id,
          `import-${index}-${randomUUID()}`,
          version.title,
          version.category,
          JSON.stringify(version.tags),
          JSON.stringify(version.blocks),
          version.createdAt,
        ));
      }
    });

    return {
      notes: this.listNotes().length,
      trash: this.listNotes({ deleted: true }).length,
      categories: this.listCategories().length,
    };
  }

  restoreVersion(noteId, versionId) {
    const current = this.getNote(noteId);
    const version = this.db.prepare(`
      SELECT id, title, category, tags_json, blocks_json FROM versions WHERE id = ? AND note_id = ?
    `).get(versionId, noteId);
    if (!current || !version || current.deletedAt) return null;

    this.transaction(() => {
      this.snapshot(current, `restore-${randomUUID()}`);
      const categoryId = this.resolveCategory(version.category);
      this.db.prepare(`
        UPDATE notes SET title = ?, category_id = ?, blocks_json = ?, updated_at = ? WHERE id = ?
      `).run(version.title, categoryId, version.blocks_json, new Date().toISOString(), noteId);
      this.setTags(noteId, parseJson(version.tags_json, []));
    });
    return this.getNote(noteId);
  }
}
