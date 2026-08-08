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
  result.blocks = blocks.map((block) => {
    if (!block || typeof block !== 'object') throw new ValidationError('Every block must be an object.');
    const type = block.type;
    if (!['text', 'heading', 'code', 'image', 'file'].includes(type)) throw new ValidationError('Unsupported block type.');
    const id = typeof block.id === 'string' && block.id.length <= 100 ? block.id : randomUUID();

    if (type === 'image') {
      const content = String(block.content || '');
      if (content && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(content)) {
        throw new ValidationError('Images must be PNG, JPEG, WebP, or GIF data.');
      }
      return { id, type, content, alt: text(String(block.alt || ''), 300, 'Image description') };
    }

    if (type === 'file') {
      const attachmentId = text(String(block.attachmentId || ''), 100, 'Attachment ID', { allowEmpty: false });
      if (!/^[a-f0-9-]{36}$/i.test(attachmentId)) throw new ValidationError('Attachment ID is invalid.');
      const size = Number(block.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024) {
        throw new ValidationError('Attachment size is invalid.');
      }
      return {
        id,
        type,
        attachmentId,
        name: text(String(block.name || ''), 255, 'Attachment name', { allowEmpty: false }),
        size,
        mime: text(String(block.mime || 'application/octet-stream'), 120, 'Attachment type', { allowEmpty: false }),
      };
    }

    const content = String(block.content || '');
    if (content.length > 1_000_000) throw new ValidationError('A content block is too large.');
    if (type === 'code') {
      return { id, type, content, language: text(String(block.language || 'powershell'), 40, 'Language') };
    }
    if (type === 'heading') {
      return { id, type, content, level: Math.min(3, Math.max(1, Number(block.level) || 2)) };
    }
    return { id, type, content };
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

  return { format: 'lambda-backup', version: 1, categories, notes };
}
