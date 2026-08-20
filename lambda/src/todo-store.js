import { randomUUID } from 'node:crypto';

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export class TodoStore {
  constructor(db, encryption = null) {
    this.db = db;
    this.encryption = encryption;
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        due_date TEXT,
        subtasks_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_todos_completed_due ON todos(completed_at, due_date, updated_at DESC);
    `);
  }

  encodeTitle(id, title) {
    return this.encryption
      ? this.encryption.encryptText(title, `lambda:todo:${id}:title:v1`)
      : title;
  }

  decodeTitle(id, title) {
    return this.encryption
      ? this.encryption.decryptText(title, `lambda:todo:${id}:title:v1`)
      : title;
  }

  encodeSubtasks(id, subtasks) {
    return this.encryption
      ? this.encryption.encryptJson(subtasks, `lambda:todo:${id}:subtasks:v1`)
      : JSON.stringify(subtasks);
  }

  decodeSubtasks(id, subtasks) {
    return this.encryption
      ? this.encryption.decryptJson(subtasks, `lambda:todo:${id}:subtasks:v1`)
      : parseJson(subtasks, []);
  }

  todoFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: this.decodeTitle(row.id, row.title),
      dueDate: row.due_date || null,
      subtasks: this.decodeSubtasks(row.id, row.subtasks_json),
      completed: Boolean(row.completed_at),
      completedAt: row.completed_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listTodos({ includeCompleted = false, completedOnly = false, search = '' } = {}) {
    const where = completedOnly
      ? 'WHERE completed_at IS NOT NULL'
      : includeCompleted
        ? ''
        : 'WHERE completed_at IS NULL';
    const order = completedOnly
      ? 'ORDER BY completed_at DESC, updated_at DESC'
      : includeCompleted
        ? 'ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, updated_at DESC'
        : 'ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, updated_at DESC';
    const todos = this.db.prepare(`SELECT * FROM todos ${where} ${order}`).all().map((row) => this.todoFromRow(row));
    const query = String(search || '').trim().toLocaleLowerCase();
    if (!query) return todos;
    return todos.filter((todo) => [todo.title, ...todo.subtasks.map((item) => item.title || '')]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query));
  }

  getTodo(id) {
    return this.todoFromRow(this.db.prepare('SELECT * FROM todos WHERE id = ?').get(String(id)));
  }

  createTodo({ title, dueDate, subtasks, completed = false }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const completedAt = completed ? now : null;
    this.db.prepare(`
      INSERT INTO todos (id, title, due_date, subtasks_json, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.encodeTitle(id, title),
      dueDate,
      this.encodeSubtasks(id, subtasks),
      now,
      now,
      completedAt,
    );
    return this.getTodo(id);
  }

  updateTodo(id, { title, dueDate, subtasks, completed = false }) {
    const current = this.getTodo(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const completedAt = completed ? (current.completedAt || now) : null;
    const changed = current.title !== title
      || current.dueDate !== dueDate
      || current.completed !== completed
      || JSON.stringify(current.subtasks) !== JSON.stringify(subtasks);
    if (!changed) return current;
    this.db.prepare(`
      UPDATE todos
      SET title = ?, due_date = ?, subtasks_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      this.encodeTitle(id, title),
      dueDate,
      this.encodeSubtasks(id, subtasks),
      now,
      completedAt,
      id,
    );
    return this.getTodo(id);
  }

  deleteTodo(id) {
    return this.db.prepare('DELETE FROM todos WHERE id = ?').run(String(id)).changes > 0;
  }

  clearCompleted() {
    return this.db.prepare('DELETE FROM todos WHERE completed_at IS NOT NULL').run().changes;
  }

  exportBackup() {
    return this.listTodos({ includeCompleted: true });
  }

  restoreBackup(todos = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM todos;');
      const insert = this.db.prepare(`
        INSERT INTO todos (id, title, due_date, subtasks_json, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const todo of todos) {
        insert.run(
          todo.id,
          this.encodeTitle(todo.id, todo.title),
          todo.dueDate,
          this.encodeSubtasks(todo.id, todo.subtasks),
          todo.createdAt,
          todo.updatedAt,
          todo.completedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      active: this.listTodos().length,
      completed: this.listTodos({ completedOnly: true }).length,
    };
  }
}
