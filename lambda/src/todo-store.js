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
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    const columns = this.db.prepare('PRAGMA table_info(todos)').all();
    if (!columns.some((column) => column.name === 'priority')) {
      this.db.exec('ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;');
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_todos_completed_priority ON todos(completed_at, priority, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_todos_completed_due ON todos(completed_at, due_date, updated_at DESC);
    `);
    this.ensureActivePriorities();
  }

  ensureActivePriorities() {
    const rows = this.db.prepare(`
      SELECT id, priority
      FROM todos
      WHERE completed_at IS NULL
      ORDER BY
        CASE WHEN priority > 0 THEN 0 ELSE 1 END,
        priority ASC,
        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
        due_date ASC,
        updated_at DESC
    `).all();

    const seen = new Set();
    const valid = rows.every((row) => {
      const priority = Number(row.priority);
      if (!Number.isSafeInteger(priority) || priority < 1 || seen.has(priority)) return false;
      seen.add(priority);
      return true;
    });
    if (valid) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE todos SET priority = ? WHERE id = ?');
      rows.forEach((row, index) => update.run(index + 1, row.id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  nextActivePriority() {
    const row = this.db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM todos WHERE completed_at IS NULL').get();
    return Number(row?.value || 0) + 1;
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
      priority: Number(row.priority || 0),
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
        ? 'ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, CASE WHEN completed_at IS NULL THEN priority ELSE 0 END ASC, completed_at DESC, updated_at DESC'
        : 'ORDER BY priority ASC, updated_at DESC';
    const todos = this.db.prepare(`SELECT * FROM todos ${where} ${order}`).all().map((row) => this.todoFromRow(row));
    const query = String(search || '').trim().toLocaleLowerCase();
    if (!query) return todos;
    return todos.filter((todo) => [todo.title, ...todo.subtasks.map((item) => item.title || '')]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query));
  }

  countActive() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM todos WHERE completed_at IS NULL').get()?.count || 0);
  }

  summaryForDate(dateKey) {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS active,
        SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) AS due_today,
        SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN due_date = date(?, '+1 day') THEN 1 ELSE 0 END) AS due_tomorrow
      FROM todos
      WHERE completed_at IS NULL
    `).get(dateKey, dateKey, dateKey);
    return {
      active: Number(row?.active || 0),
      dueToday: Number(row?.due_today || 0),
      overdue: Number(row?.overdue || 0),
      dueTomorrow: Number(row?.due_tomorrow || 0),
    };
  }

  getTodo(id) {
    return this.todoFromRow(this.db.prepare('SELECT * FROM todos WHERE id = ?').get(String(id)));
  }

  createTodo({ title, dueDate, subtasks, completed = false }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const completedAt = completed ? now : null;
    const priority = completed ? 0 : this.nextActivePriority();
    this.db.prepare(`
      INSERT INTO todos (id, title, due_date, subtasks_json, priority, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.encodeTitle(id, title),
      dueDate,
      this.encodeSubtasks(id, subtasks),
      priority,
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
    const priority = current.completed && !completed ? this.nextActivePriority() : current.priority;
    const changed = current.title !== title
      || current.dueDate !== dueDate
      || current.completed !== completed
      || JSON.stringify(current.subtasks) !== JSON.stringify(subtasks);
    if (!changed) return current;
    this.db.prepare(`
      UPDATE todos
      SET title = ?, due_date = ?, subtasks_json = ?, priority = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      this.encodeTitle(id, title),
      dueDate,
      this.encodeSubtasks(id, subtasks),
      priority,
      now,
      completedAt,
      id,
    );
    return this.getTodo(id);
  }

  reorderActive(ids) {
    if (!Array.isArray(ids)) {
      const error = new Error('To-do order must be a list of IDs.');
      error.statusCode = 400;
      throw error;
    }
    const requested = ids.map((id) => String(id));
    if (new Set(requested).size !== requested.length) {
      const error = new Error('To-do order contains duplicate IDs.');
      error.statusCode = 400;
      throw error;
    }

    const activeIds = this.db.prepare('SELECT id FROM todos WHERE completed_at IS NULL').all().map((row) => row.id);
    const activeSet = new Set(activeIds);
    if (requested.length !== activeIds.length || requested.some((id) => !activeSet.has(id))) {
      const error = new Error('To-do order is stale. Refresh the active list and try again.');
      error.statusCode = 409;
      throw error;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE todos SET priority = ?, updated_at = ? WHERE id = ? AND completed_at IS NULL');
      const now = new Date().toISOString();
      requested.forEach((id, index) => update.run(index + 1, now, id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listTodos();
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
        INSERT INTO todos (id, title, due_date, subtasks_json, priority, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const todo of todos) {
        insert.run(
          todo.id,
          this.encodeTitle(todo.id, todo.title),
          todo.dueDate,
          this.encodeSubtasks(todo.id, todo.subtasks),
          Number.isSafeInteger(Number(todo.priority)) && Number(todo.priority) > 0 ? Number(todo.priority) : 0,
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
    this.ensureActivePriorities();
    return {
      active: this.countActive(),
      completed: this.listTodos({ completedOnly: true }).length,
    };
  }
}
