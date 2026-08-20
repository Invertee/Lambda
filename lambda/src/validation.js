import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {}

function text(value, max, field, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`);
  const cleaned = value.trim();
  if (!allowEmpty && !cleaned) throw new ValidationError(`${field} is required.`);
  if (cleaned.length > max) throw new ValidationError(`${field} is too long.`);
  return cleaned;
}

export function validateCategoryName(value) {
  return text(value, 80, 'Category name', { allowEmpty: false });
}

export function validateBlockCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) throw new ValidationError('Block code must be 5 alphanumeric characters.');
  return code;
}

function optionalBlockCode(value) {
  if (value === undefined || value === null || value === '') return '';
  return validateBlockCode(value);
}

function withCode(block, code) {
  return code ? { ...block, code } : block;
}

function dueDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('Due date must use YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Due date is invalid.');
  }
  return value;
}

function validateSubtasks(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 100) throw new ValidationError('Subtasks must be a list of at most 100 items.');
  const seen = new Set();
  return input.map((item) => {
    const source = typeof item === 'string' ? { title: item } : item;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new ValidationError('Every subtask must be text or an object.');
    const id = typeof source.id === 'string' && source.id.length <= 100 ? source.id : randomUUID();
    if (seen.has(id)) throw new ValidationError('Subtask IDs must be unique within a to-do.');
    seen.add(id);
    return {
      id,
      title: text(String(source.title || ''), 300, 'Subtask title', { allowEmpty: false }),
      completed: Boolean(source.completed),
    };
  });
}

export function validateTodo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('A to-do object is required.');
  }
  return {
    title: text(String(input.title || ''), 300, 'To-do title', { allowEmpty: false }),
    dueDate: dueDate(input.dueDate ?? input.due_date),
    subtasks: validateSubtasks(input.subtasks),
    completed: Boolean(input.completed),
  };
}

export function validateNote(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('A note object is required.');
  }

  const fallbackBlocks = [];
  const result = {
    title: text(input.title ?? (partial ? '' : 'Untitled note'), 200, 'Title') || 'Untitled note',
    category: text(input.category, 80, 'Category', { allowEmpty: false }),
    versionToken: typeof input.versionToken === 'string' && input.versionToken.length <= 100
      ? input.versionToken
      : randomUUID(),
  };

  if (!Array.isArray(input.tags)) throw new ValidationError('Tags must be a list.');
  const seenTags = new Set();
  result.tags = input.tags.map((tag) => text(tag, 40, 'Tag', { allowEmpty: false }))
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (seenTags.has(key)) return false;
      seenTags.add(key);
      return true;
    });
  if (result.tags.length > 20) throw new ValidationError('A note can have at most 20 tags.');

  const blocks = input.blocks ?? fallbackBlocks;
  if (!Array.isArray(blocks) || blocks.length > 100) throw new ValidationError('Blocks must be a list of at most 100 items.');
  const seenBlockIds = new Set();
  result.blocks = blocks.map((block) => {
    if (!block || typeof block !== 'object') throw new ValidationError('Every block must be an object.');
    const type = block.type === 'heading' ? 'text' : block.type;
    if (!['text', 'code', 'csv', 'image', 'file'].includes(type)) throw new ValidationError('Unsupported block type.');
    const id = typeof block.id === 'string' && block.id.length <= 100 ? block.id : randomUUID();
    if (seenBlockIds.has(id)) throw new ValidationError('Block IDs must be unique within a note.');
    seenBlockIds.add(id);
    const code = optionalBlockCode(block.code);

    if (type === 'image') {
      const content = String(block.content || '');
      if (content && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(content)) {
        throw new ValidationError('Images must be PNG, JPEG, WebP, or GIF data.');
      }
      return withCode({ id, type, content, alt: text(String(block.alt || ''), 300, 'Image description') }, code);
    }

    if (type === 'file') {
      const attachmentId = text(String(block.attachmentId || ''), 100, 'Attachment ID', { allowEmpty: false });
      if (!/^[a-f0-9-]{36}$/i.test(attachmentId)) throw new ValidationError('Attachment ID is invalid.');
      const size = Number(block.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) {
        throw new ValidationError('Attachment size is invalid.');
      }
      return withCode({
        id,
        type,
        attachmentId,
        name: text(String(block.name || ''), 255, 'Attachment name', { allowEmpty: false }),
        size,
        mime: text(String(block.mime || 'application/octet-stream'), 120, 'Attachment type', { allowEmpty: false }),
      }, code);
    }

    const content = String(block.content || '');
    if (content.length > 1_000_000) throw new ValidationError('A content block is too large.');
    if (type === 'code') {
      return withCode({ id, type, content, language: text(String(block.language || 'powershell'), 40, 'Language') }, code);
    }
    return withCode({ id, type, content }, code);
  });

  return result;
}

function timestamp(value, field, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid timestamp.`);
  }
  return value;
}

export function validateBackup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('A backup object is required.');
  }
  if (input.format !== 'lambda-backup' || input.version !== 1) {
    throw new ValidationError('This is not a supported Lambda backup.');
  }
  if (!Array.isArray(input.categories) || !Array.isArray(input.notes)) {
    throw new ValidationError('The backup must contain categories and notes.');
  }
  if (input.categories.length > 10_000 || input.notes.length > 100_000) {
    throw new ValidationError('The backup contains too many items.');
  }

  const categoryKeys = new Set();
  const categories = input.categories.map((category) => {
    const name = validateCategoryName(category?.name);
    const key = name.toLocaleLowerCase();
    if (categoryKeys.has(key)) throw new ValidationError(`Duplicate category: ${name}.`);
    categoryKeys.add(key);
    return { name };
  });

  const noteIds = new Set();
  const notes = input.notes.map((inputNote) => {
    if (!inputNote || typeof inputNote !== 'object' || Array.isArray(inputNote)) {
      throw new ValidationError('Every backup note must be an object.');
    }
    const id = String(inputNote.id || '');
    if (!/^[a-f0-9-]{1,100}$/i.test(id)) throw new ValidationError('A backup note has an invalid ID.');
    if (noteIds.has(id.toLocaleLowerCase())) throw new ValidationError(`Duplicate note ID: ${id}.`);
    noteIds.add(id.toLocaleLowerCase());
    const note = validateNote(inputNote);
    if (!Array.isArray(inputNote.versions) || inputNote.versions.length > 20) {
      throw new ValidationError('Each backup note must have at most 20 versions.');
    }
    const versions = inputNote.versions.map((inputVersion) => {
      const version = validateNote({ ...inputVersion, category: inputVersion?.category || 'General' });
      return {
        title: version.title,
        category: version.category,
        tags: version.tags,
        blocks: version.blocks,
        createdAt: timestamp(inputVersion?.createdAt, 'Version date'),
      };
    });
    return {
      id,
      title: note.title,
      category: note.category,
      tags: note.tags,
      blocks: note.blocks,
      createdAt: timestamp(inputNote.createdAt, 'Created date'),
      updatedAt: timestamp(inputNote.updatedAt, 'Updated date'),
      deletedAt: timestamp(inputNote.deletedAt, 'Deleted date', { nullable: true }),
      versions,
    };
  });

  const todoIds = new Set();
  const todos = (Array.isArray(input.todos) ? input.todos : []).map((inputTodo) => {
    if (!inputTodo || typeof inputTodo !== 'object' || Array.isArray(inputTodo)) {
      throw new ValidationError('Every backup to-do must be an object.');
    }
    const id = String(inputTodo.id || '');
    if (!/^[a-f0-9-]{1,100}$/i.test(id)) throw new ValidationError('A backup to-do has an invalid ID.');
    if (todoIds.has(id.toLocaleLowerCase())) throw new ValidationError(`Duplicate to-do ID: ${id}.`);
    todoIds.add(id.toLocaleLowerCase());
    const todo = validateTodo({
      title: inputTodo.title,
      dueDate: inputTodo.dueDate,
      subtasks: inputTodo.subtasks,
      completed: Boolean(inputTodo.completedAt),
    });
    return {
      id,
      title: todo.title,
      dueDate: todo.dueDate,
      subtasks: todo.subtasks,
      completed: Boolean(inputTodo.completedAt),
      completedAt: timestamp(inputTodo.completedAt, 'To-do completion date', { nullable: true }),
      createdAt: timestamp(inputTodo.createdAt, 'To-do created date'),
      updatedAt: timestamp(inputTodo.updatedAt, 'To-do updated date'),
    };
  });

  return { format: 'lambda-backup', version: 1, categories, notes, todos };
}
