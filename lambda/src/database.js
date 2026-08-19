import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

const BLOCK_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function sessionDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function blockCodeCandidate() {
  const bytes = randomBytes(5);
  let code = '';
  for (const byte of bytes) code += BLOCK_CODE_CHARS[byte % BLOCK_CODE_CHARS.length];
  return code;
}

function normalizeLegacyBlock(block) {
  if (!block || block.type !== 'heading') return block;
  const { level, ...rest } = block;
  return { ...rest, type: 'text' };
}

class SqliteSessionStore {
  constructor(db) { this.db = db; }
  get(token) { return this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sessionDigest(token))?.expires_at; }
  set(token, expiresAt) {
    this.db.prepare(`INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at`).run(sessionDigest(token), expiresAt);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
  delete(token) { return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sessionDigest(token)).changes > 0; }
  has(token) { return Boolean(this.get(token)); }
}

export class SnippetDatabase {
  constructor(filename, encryption = null) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.encryption = encryption;
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.sessions = new SqliteSessionStore(this.db);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, blocks_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      CREATE TABLE IF NOT EXISTS note_tags (note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (note_id, tag_id));
      CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, version_key TEXT NOT NULL, title TEXT NOT NULL, category TEXT, tags_json TEXT NOT NULL, blocks_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(note_id, version_key));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS block_refs (
        code TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_deleted_updated ON notes(deleted_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_versions_note_created ON versions(note_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_block_refs_note ON block_refs(note_id, active);
      INSERT OR IGNORE INTO categories (name, created_at) VALUES ('General', datetime('now'));
      UPDATE notes SET category_id = (SELECT id FROM categories WHERE name = 'General' COLLATE NOCASE) WHERE category_id IS NULL;
    `);
    this.rebuildBlockRefs();
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  encodeTitle(id, title) { return this.encryption ? this.encryption.encryptText(title, `lambda:note:${id}:title:v1`) : title; }
  decodeTitle(id, title) { return this.encryption ? this.encryption.decryptText(title, `lambda:note:${id}:title:v1`) : title; }
  encodeBlocks(id, blocks) { return this.encryption ? this.encryption.encryptJson(blocks, `lambda:note:${id}:blocks:v1`) : JSON.stringify(blocks); }
  decodeBlocks(id, blocks) { return this.encryption ? this.encryption.decryptJson(blocks, `lambda:note:${id}:blocks:v1`) : parseJson(blocks, []); }
  encodeVersionTitle(noteId, versionKey, title) { return this.encryption ? this.encryption.encryptText(title, `lambda:version:${noteId}:${versionKey}:title:v1`) : title; }
  decodeVersionTitle(noteId, versionKey, title) { return this.encryption ? this.encryption.decryptText(title, `lambda:version:${noteId}:${versionKey}:title:v1`) : title; }
  encodeVersionBlocks(noteId, versionKey, blocks) { return this.encryption ? this.encryption.encryptJson(blocks, `lambda:version:${noteId}:${versionKey}:blocks:v1`) : JSON.stringify(blocks); }
  decodeVersionBlocks(noteId, versionKey, blocks) { return this.encryption ? this.encryption.decryptJson(blocks, `lambda:version:${noteId}:${versionKey}:blocks:v1`) : parseJson(blocks, []); }

  noteFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: this.decodeTitle(row.id, row.title),
      categoryId: row.category_id ?? null,
      category: row.category ?? null,
      tags: parseJson(row.tags_json, []),
      blocks: this.decodeBlocks(row.id, row.blocks_json).map(normalizeLegacyBlock),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  listNotes({ deleted = false, category = '', tag = '', search = '' } = {}) {
    const comparator = deleted ? 'IS NOT NULL' : 'IS NULL';
    const notes = this.db.prepare(`${NOTE_SELECT} WHERE n.deleted_at ${comparator} ORDER BY n.updated_at DESC`).all().map((row) => this.noteFromRow(row));
    const categoryKey = String(category).trim().toLocaleLowerCase();
    const tagKey = String(tag).trim().toLocaleLowerCase();
    const searchKey = String(search).trim().toLocaleLowerCase();
    return notes.filter((note) => {
      if (categoryKey && String(note.category || '').toLocaleLowerCase() !== categoryKey) return false;
      if (tagKey && !note.tags.some((item) => item.toLocaleLowerCase() === tagKey)) return false;
      if (searchKey) {
        const searchable = [note.title, note.category || '', ...note.tags,
          ...note.blocks.map((block) => `${block.code || ''} ${block.content || ''} ${block.language || ''} ${block.alt || ''} ${block.name || ''}`),
        ].join(' ').toLocaleLowerCase();
        if (!searchable.includes(searchKey)) return false;
      }
      return true;
    });
  }

  getNote(id) { return this.noteFromRow(this.db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id)); }

  listCategories() {
    return this.db.prepare(`SELECT c.id, c.name, COUNT(n.id) AS note_count FROM categories c
      LEFT JOIN notes n ON n.category_id = c.id AND n.deleted_at IS NULL
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all().map((row) => ({ id: row.id, name: row.name, noteCount: row.note_count }));
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
    if (existing) { const error = new Error('A category with that name already exists.'); error.statusCode = 409; throw error; }
    this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(cleaned, id);
    return { id: category.id, name: cleaned };
  }

  deleteCategory(id) {
    if (!this.db.prepare('SELECT id FROM categories WHERE id = ?').get(id)) return false;
    if (this.db.prepare('SELECT 1 FROM notes WHERE category_id = ? LIMIT 1').get(id)) {
      const error = new Error('Move the notes in this category before deleting it.'); error.statusCode = 409; throw error;
    }
    return this.db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0;
  }

  resolveCategory(name) { return this.createCategory(name || 'General').id; }

  setTags(noteId, tags) {
    this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
    const getTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
    const linkTag = this.db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)');
    for (const tag of tags) { insertTag.run(tag); linkTag.run(noteId, getTag.get(tag).id); }
    this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)');
  }

  generateBlockCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = blockCodeCandidate();
      if (!this.db.prepare('SELECT 1 FROM block_refs WHERE code = ?').get(code)) return code;
    }
    throw new Error('Could not allocate a unique block code.');
  }

  prepareBlocks(noteId, blocks, currentBlocks = []) {
    const currentById = new Map(currentBlocks.map((block) => [block.id, block]));
    const seenCodes = new Set();
    return blocks.map((block) => {
      const current = currentById.get(block.id);
      let code = String(block.code || current?.code || '').toUpperCase();
      if (code && !/^[A-Z0-9]{5}$/.test(code)) code = '';
      if (code) {
        const owner = this.db.prepare('SELECT note_id, block_id FROM block_refs WHERE code = ?').get(code);
        if (owner && (owner.note_id !== noteId || owner.block_id !== block.id)) {
          const error = new Error(`Block code ${code} is already in use.`);
          error.statusCode = 409;
          throw error;
        }
      }
      if (!code) code = this.generateBlockCode();
      if (seenCodes.has(code)) {
        const error = new Error(`Duplicate block code ${code}.`);
        error.statusCode = 409;
        throw error;
      }
      seenCodes.add(code);
      return { ...block, code };
    });
  }

  syncBlockRefs(noteId, blocks, active = true) {
    this.db.prepare('UPDATE block_refs SET active = 0 WHERE note_id = ?').run(noteId);
    const upsert = this.db.prepare(`
      INSERT INTO block_refs (code, note_id, block_id, active, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET note_id = excluded.note_id, block_id = excluded.block_id, active = excluded.active
    `);
    const now = new Date().toISOString();
    for (const block of blocks) upsert.run(block.code, noteId, block.id, active ? 1 : 0, now);
  }

  rebuildBlockRefs() {
    const notes = this.db.prepare(`${NOTE_SELECT} ORDER BY n.created_at`).all().map((row) => this.noteFromRow(row));
    for (const note of notes) {
      const prepared = this.prepareBlocks(note.id, note.blocks, note.blocks);
      const changed = JSON.stringify(prepared) !== JSON.stringify(note.blocks);
      if (changed) {
        this.db.prepare('UPDATE notes SET blocks_json = ? WHERE id = ?').run(this.encodeBlocks(note.id, prepared), note.id);
      }
      this.syncBlockRefs(note.id, prepared, !note.deletedAt);
    }
  }

  createNote({ title, category, tags, blocks }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    let preparedBlocks;
    this.transaction(() => {
      preparedBlocks = this.prepareBlocks(id, blocks);
      const categoryId = this.resolveCategory(category);
      this.db.prepare(`INSERT INTO notes (id, title, category_id, blocks_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, this.encodeTitle(id, title), categoryId, this.encodeBlocks(id, preparedBlocks), now, now);
      this.setTags(id, tags);
      this.syncBlockRefs(id, preparedBlocks, true);
    });
    return this.getNote(id);
  }

  snapshot(note, versionKey) {
    this.db.prepare(`INSERT OR IGNORE INTO versions (note_id, version_key, title, category, tags_json, blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(note.id, versionKey, this.encodeVersionTitle(note.id, versionKey, note.title), note.category, JSON.stringify(note.tags), this.encodeVersionBlocks(note.id, versionKey, note.blocks), new Date().toISOString());
    this.db.prepare(`DELETE FROM versions WHERE note_id = ? AND id NOT IN (SELECT id FROM versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 20)`).run(note.id, note.id);
  }

  updateNote(id, { title, category, tags, blocks, versionToken }) {
    const current = this.getNote(id);
    if (!current || current.deletedAt) return null;
    const preparedBlocks = this.prepareBlocks(id, blocks, current.blocks);
    const changed = current.title !== title || (current.category || '') !== (category || '') || JSON.stringify(current.tags) !== JSON.stringify(tags) || JSON.stringify(current.blocks) !== JSON.stringify(preparedBlocks);
    if (!changed) return current;
    this.transaction(() => {
      this.snapshot(current, versionToken || randomUUID());
      const categoryId = this.resolveCategory(category);
      this.db.prepare(`UPDATE notes SET title = ?, category_id = ?, blocks_json = ?, updated_at = ? WHERE id = ?`)
        .run(this.encodeTitle(id, title), categoryId, this.encodeBlocks(id, preparedBlocks), new Date().toISOString(), id);
      this.setTags(id, tags);
      this.syncBlockRefs(id, preparedBlocks, true);
    });
    return this.getNote(id);
  }

  getBlock(code) {
    const ref = this.db.prepare('SELECT note_id, block_id FROM block_refs WHERE code = ? AND active = 1').get(String(code).toUpperCase());
    if (!ref) return null;
    const note = this.getNote(ref.note_id);
    if (!note || note.deletedAt) return null;
    const block = note.blocks.find((item) => item.id === ref.block_id && item.code === String(code).toUpperCase());
    if (!block) return null;
    return {
      code: block.code,
      noteId: note.id,
      noteTitle: note.title,
      category: note.category,
      block,
      updatedAt: note.updatedAt,
    };
  }

  updateBlock(code, changes = {}) {
    const target = this.getBlock(code);
    if (!target) return null;
    const current = target.block;
    const requestedType = changes.type === undefined ? current.type : String(changes.type);
    const type = requestedType === 'heading' ? 'text' : requestedType;
    if (!['text', 'code', 'csv'].includes(type)) {
      const error = new Error('Direct block updates support text, code, and csv blocks.');
      error.statusCode = 400;
      throw error;
    }
    const content = changes.content === undefined ? String(current.content || '') : String(changes.content);
    if (content.length > 1_000_000) {
      const error = new Error('Block content is too large.');
      error.statusCode = 400;
      throw error;
    }
    const replacement = { id: current.id, code: current.code, type, content };
    if (type === 'code') replacement.language = String(changes.language ?? current.language ?? 'powershell').slice(0, 40);

    const note = this.getNote(target.noteId);
    const blocks = note.blocks.map((block) => block.id === current.id ? replacement : block);
    const updated = this.updateNote(note.id, {
      title: note.title,
      category: note.category,
      tags: note.tags,
      blocks,
      versionToken: randomUUID(),
    });
    return updated ? this.getBlock(current.code) : null;
  }

  softDelete(id) {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const changed = this.db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, id).changes > 0;
      if (changed) this.db.prepare('UPDATE block_refs SET active = 0 WHERE note_id = ?').run(id);
      return changed;
    });
  }

  restoreNote(id) {
    return this.transaction(() => {
      const changed = this.db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL').run(new Date().toISOString(), id).changes > 0;
      if (changed) this.db.prepare('UPDATE block_refs SET active = 1 WHERE note_id = ?').run(id);
      return changed;
    });
  }

  permanentlyDelete(id) {
    const current = this.getNote(id);
    if (!current || !current.deletedAt) return false;
    return this.transaction(() => {
      this.db.prepare('UPDATE block_refs SET active = 0 WHERE note_id = ?').run(id);
      return this.db.prepare('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
    });
  }

  listVersions(noteId) {
    return this.db.prepare(`SELECT id, version_key, title, category, tags_json, blocks_json, created_at FROM versions WHERE note_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(noteId).map((row) => ({
      id: row.id,
      title: this.decodeVersionTitle(noteId, row.version_key, row.title),
      category: row.category,
      tags: parseJson(row.tags_json, []),
      blocks: this.decodeVersionBlocks(noteId, row.version_key, row.blocks_json).map(normalizeLegacyBlock),
      createdAt: row.created_at,
    }));
  }

  exportBackup() {
    const notes = [...this.listNotes(), ...this.listNotes({ deleted: true })].map((note) => ({ ...note, versions: this.listVersions(note.id) }));
    return { format: 'lambda-backup', version: 1, exportedAt: new Date().toISOString(), categories: this.listCategories(), notes };
  }

  restoreBackup(backup) {
    this.transaction(() => {
      this.db.exec('DELETE FROM note_tags; DELETE FROM versions; DELETE FROM notes; DELETE FROM tags; DELETE FROM categories; UPDATE block_refs SET active = 0;');
      const insertCategory = this.db.prepare('INSERT OR IGNORE INTO categories (name, created_at) VALUES (?, ?)');
      for (const category of backup.categories) insertCategory.run(category.name, new Date().toISOString());
      for (const note of backup.notes) insertCategory.run(note.category, note.createdAt);
      if (!backup.categories.length && !backup.notes.length) insertCategory.run('General', new Date().toISOString());
      const categoryId = this.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE');
      const insertNote = this.db.prepare(`INSERT INTO notes (id, title, category_id, blocks_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertVersion = this.db.prepare(`INSERT INTO versions (note_id, version_key, title, category, tags_json, blocks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const note of backup.notes) {
        const preparedBlocks = this.prepareBlocks(note.id, note.blocks);
        insertNote.run(note.id, this.encodeTitle(note.id, note.title), categoryId.get(note.category).id, this.encodeBlocks(note.id, preparedBlocks), note.createdAt, note.updatedAt, note.deletedAt);
        this.setTags(note.id, note.tags);
        this.syncBlockRefs(note.id, preparedBlocks, !note.deletedAt);
        note.versions.forEach((version, index) => {
          const versionKey = `import-${index}-${randomUUID()}`;
          const versionBlocks = version.blocks.map((block) => ({ ...block }));
          insertVersion.run(note.id, versionKey, this.encodeVersionTitle(note.id, versionKey, version.title), version.category, JSON.stringify(version.tags), this.encodeVersionBlocks(note.id, versionKey, versionBlocks), version.createdAt);
        });
      }
    });
    return { notes: this.listNotes().length, trash: this.listNotes({ deleted: true }).length, categories: this.listCategories().length };
  }

  restoreVersion(noteId, versionId) {
    const current = this.getNote(noteId);
    const version = this.db.prepare(`SELECT id, version_key, title, category, tags_json, blocks_json FROM versions WHERE id = ? AND note_id = ?`).get(versionId, noteId);
    if (!current || !version || current.deletedAt) return null;
    const title = this.decodeVersionTitle(noteId, version.version_key, version.title);
    const restoredBlocks = this.decodeVersionBlocks(noteId, version.version_key, version.blocks_json).map(normalizeLegacyBlock);
    const currentById = new Map(current.blocks.map((block) => [block.id, block]));
    const blocks = restoredBlocks.map((block) => ({ ...block, code: currentById.get(block.id)?.code || block.code }));
    this.transaction(() => {
      this.snapshot(current, `restore-${randomUUID()}`);
      const preparedBlocks = this.prepareBlocks(noteId, blocks, current.blocks);
      const categoryId = this.resolveCategory(version.category);
      this.db.prepare(`UPDATE notes SET title = ?, category_id = ?, blocks_json = ?, updated_at = ? WHERE id = ?`)
        .run(this.encodeTitle(noteId, title), categoryId, this.encodeBlocks(noteId, preparedBlocks), new Date().toISOString(), noteId);
      this.setTags(noteId, parseJson(version.tags_json, []));
      this.syncBlockRefs(noteId, preparedBlocks, true);
    });
    return this.getNote(noteId);
  }
}
