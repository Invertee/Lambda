import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNote, validateTodo, ValidationError } from '../src/validation.js';

test('normalises tags and legacy heading blocks', () => {
  const note = validateNote({
    title: ' Example ',
    category: ' Work ',
    tags: [' Node ', 'node', 'sqlite'],
    blocks: [{ type: 'heading', content: 'Title', level: 9 }],
  });
  assert.equal(note.title, 'Example');
  assert.equal(note.category, 'Work');
  assert.deepEqual(note.tags, ['Node', 'sqlite']);
  assert.equal(note.blocks[0].type, 'text');
  assert.equal(note.blocks[0].content, 'Title');
  assert.equal('level' in note.blocks[0], false);
  assert.ok(note.blocks[0].id);
});

test('creates notes without a default text block', () => {
  const note = validateNote({
    title: 'Empty note',
    category: 'Work',
    tags: [],
  });
  assert.deepEqual(note.blocks, []);
});

test('validates todo due dates and normalises string subtasks', () => {
  const todo = validateTodo({
    title: ' Review tenant ',
    dueDate: '2026-08-22',
    subtasks: [' Export configuration ', { title: 'Review exclusions', completed: true }],
  });
  assert.equal(todo.title, 'Review tenant');
  assert.equal(todo.dueDate, '2026-08-22');
  assert.equal(todo.completed, false);
  assert.equal(todo.subtasks.length, 2);
  assert.equal(todo.subtasks[0].title, 'Export configuration');
  assert.equal(todo.subtasks[1].completed, true);
  assert.ok(todo.subtasks[0].id);
});

test('rejects invalid todo due dates', () => {
  assert.throws(() => validateTodo({
    title: 'Bad date',
    dueDate: '2026-02-31',
    subtasks: [],
  }), /Due date is invalid/);
});

test('rejects unsupported image data', () => {
  assert.throws(() => validateNote({
    title: 'Bad image',
    category: null,
    tags: [],
    blocks: [{ type: 'image', content: 'https://example.com/image.png' }],
  }), ValidationError);
});

test('requires a category', () => {
  assert.throws(() => validateNote({
    title: 'Missing category',
    category: null,
    tags: [],
    blocks: [],
  }), /Category must be text/);
});

test('normalises a disk-backed file block', () => {
  const note = validateNote({
    title: 'Files',
    category: 'Reference',
    tags: [],
    blocks: [{
      type: 'file',
      attachmentId: '9f55d282-44ef-4c74-8f90-7195a3ac8509',
      name: 'example.zip',
      size: 128,
      mime: 'application/zip',
    }],
  });
  assert.equal(note.blocks[0].name, 'example.zip');
  assert.equal(note.blocks[0].size, 128);
});
