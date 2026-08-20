import { randomUUID } from 'node:crypto';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { validateBlockCode, validateCategoryName, validateNote, validateTodo } from './validation.js';

const SERVER_NAME = 'lambda-notes';
const SERVER_VERSION = '1.3.6';

const blockSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Optional stable block ID.' },
    code: { type: 'string', pattern: '^[A-Za-z0-9]{5}$', description: 'Server-assigned five-character block code.' },
    type: { type: 'string', enum: ['text', 'code', 'csv'], description: 'Block type.' },
    content: { type: 'string', description: 'Block text, source code, or CSV content.' },
    language: { type: 'string', description: 'Language identifier for a code block.' },
  },
  required: ['type', 'content'],
  additionalProperties: false,
};

const noteFields = {
  title: { type: 'string', maxLength: 200, description: 'Human-readable note title.' },
  category: { type: 'string', maxLength: 80, description: 'Category name. It is created automatically if needed.' },
  tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
  blocks: { type: 'array', maxItems: 100, items: blockSchema, description: 'Complete ordered block list.' },
  content: { type: 'string', description: 'Convenience alternative to blocks for a single text, code, or CSV block.' },
  content_type: { type: 'string', enum: ['text', 'code', 'csv'], description: 'Type used with content. Defaults to text.' },
  language: { type: 'string', description: 'Language used when content_type is code.' },
};

const subtaskSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Optional stable subtask ID.' },
    title: { type: 'string', maxLength: 300 },
    completed: { type: 'boolean', default: false },
  },
  required: ['title'],
  additionalProperties: false,
};

const todoFields = {
  title: { type: 'string', maxLength: 300, description: 'To-do title.' },
  due_date: {
    type: 'string',
    pattern: '^(?:\\d{4}-\\d{2}-\\d{2})?$',
    description: 'Optional due date in YYYY-MM-DD format. Use an empty string to clear an existing due date.',
  },
  subtasks: { type: 'array', maxItems: 100, items: subtaskSchema },
  completed: { type: 'boolean', description: 'Whether the to-do is completed.' },
};

export const MCP_TOOLS = [
  {
    name: 'list_todos',
    title: 'List to-dos',
    description: 'List active to-dos by default in priority order. Completed to-dos are excluded unless explicitly requested.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive search across to-do and subtask titles.' },
        include_completed: { type: 'boolean', default: false, description: 'Include active and completed to-dos.' },
        completed_only: { type: 'boolean', default: false, description: 'Return only completed to-dos.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_todo',
    title: 'Get a to-do',
    description: 'Get one to-do including priority, due date, completion state, and subtasks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'To-do UUID.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_todo',
    title: 'Create a to-do',
    description: 'Create a new active to-do with an optional due date and subtasks. New active items are appended to the priority list.',
    inputSchema: {
      type: 'object',
      properties: todoFields,
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_todo',
    title: 'Update a to-do',
    description: 'Partially update a to-do title, due date, subtasks, or completion state.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'To-do UUID.' }, ...todoFields },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'reorder_todos',
    title: 'Reorder active to-dos',
    description: 'Set the priority order of every active to-do. Supply all active to-do IDs from highest to lowest priority.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'All active to-do UUIDs in the desired priority order.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'complete_todo',
    title: 'Complete or reopen a to-do',
    description: 'Mark a to-do complete. Set completed to false to reopen it; reopened items are appended to the active priority list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'To-do UUID.' },
        completed: { type: 'boolean', default: true },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_todo',
    title: 'Delete a to-do',
    description: 'Permanently delete one to-do.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'To-do UUID.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'clear_completed_todos',
    title: 'Clear completed to-dos',
    description: 'Permanently delete every completed to-do while leaving active to-dos untouched.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_notes',
    title: 'List and search notes',
    description: 'List active notes ordered by most recently updated, optionally filtering by query, category, tag, or block code.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text matched across title, category, tags, block codes, and block content.' },
        category: { type: 'string' },
        tag: { type: 'string' },
        include_deleted: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_note',
    title: 'Get a note',
    description: 'Get one complete note, including its ordered content blocks, five-character block codes, and tags.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note UUID.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_block',
    title: 'Get a block by code',
    description: 'Retrieve one active block directly using its five-character alphanumeric code.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^[A-Za-z0-9]{5}$' } },
      required: ['code'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'update_block',
    title: 'Update a block by code',
    description: 'Replace the content of an active text, code, or CSV block using its five-character code.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[A-Za-z0-9]{5}$' },
        content: { type: 'string' },
        type: { type: 'string', enum: ['text', 'code', 'csv'] },
        language: { type: 'string' },
      },
      required: ['code', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_note',
    title: 'Create a note',
    description: 'Create a note. Supply blocks for a structured note, or content for a convenient single-block note.',
    inputSchema: {
      type: 'object',
      properties: noteFields,
      required: ['title', 'category'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_note',
    title: 'Update a note',
    description: 'Partially update a note. Only supplied fields are changed. Supplying content replaces the blocks with one block.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note UUID.' }, ...noteFields },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_note',
    title: 'Move a note to the recycle bin',
    description: 'Soft-delete a note. It remains recoverable from the Lambda recycle bin.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note UUID.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'restore_note',
    title: 'Restore a note',
    description: 'Restore a soft-deleted note from the Lambda recycle bin.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note UUID.' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_categories',
    title: 'List categories',
    description: 'List all categories and their active note counts.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_category',
    title: 'Create a category',
    description: 'Create a category, returning the existing category when the name is already present.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 80 } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'rename_category',
    title: 'Rename a category',
    description: 'Rename a category and update its name for every associated note.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string', maxLength: 80 } },
      required: ['id', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_category',
    title: 'Delete an empty category',
    description: 'Delete a category only when no active or deleted notes use it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function blocksFromArguments(args) {
  if (args.blocks !== undefined) return args.blocks;
  const type = args.content_type || 'text';
  const block = { type, content: String(args.content || '') };
  if (type === 'code') block.language = args.language || 'powershell';
  return [block];
}

function createNote(database, args) {
  return database.createNote(validateNote({
    title: args.title,
    category: args.category,
    tags: args.tags || [],
    blocks: blocksFromArguments(args),
  }));
}

function updateNote(database, args) {
  const current = database.getNote(String(args.id || ''));
  if (!current || current.deletedAt) throw new Error('Active note not found.');
  const has = (key) => Object.hasOwn(args, key);
  const usesContent = has('content') || has('content_type') || has('language');
  return database.updateNote(current.id, validateNote({
    title: has('title') ? args.title : current.title,
    category: has('category') ? args.category : current.category,
    tags: has('tags') ? args.tags : current.tags,
    blocks: has('blocks') ? args.blocks : (usesContent ? blocksFromArguments(args) : current.blocks),
    versionToken: randomUUID(),
  }));
}

function listNotes(database, args) {
  const filters = { category: args.category, tag: args.tag, search: args.query };
  const notes = database.listNotes(filters);
  return args.include_deleted ? [...notes, ...database.listNotes({ ...filters, deleted: true })] : notes;
}

function requireResult(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function mergeTodo(todos, args) {
  const current = requireResult(todos.getTodo(String(args.id || '')), 'To-do not found.');
  const has = (key) => Object.hasOwn(args, key);
  return validateTodo({
    title: has('title') ? args.title : current.title,
    dueDate: has('due_date') ? args.due_date : current.dueDate,
    subtasks: has('subtasks') ? args.subtasks : current.subtasks,
    completed: has('completed') ? args.completed : current.completed,
  });
}

function toolHandlers(database, todos) {
  return {
    list_todos: (args) => todos.listTodos({
      includeCompleted: Boolean(args.include_completed),
      completedOnly: Boolean(args.completed_only),
      search: args.query || '',
    }),
    get_todo: (args) => requireResult(todos.getTodo(String(args.id || '')), 'To-do not found.'),
    create_todo: (args) => todos.createTodo(validateTodo({
      title: args.title,
      dueDate: args.due_date,
      subtasks: args.subtasks || [],
      completed: Boolean(args.completed),
    })),
    update_todo: (args) => requireResult(todos.updateTodo(String(args.id || ''), mergeTodo(todos, args)), 'To-do not found.'),
    reorder_todos: (args) => todos.reorderActive(args.ids),
    complete_todo: (args) => {
      const current = requireResult(todos.getTodo(String(args.id || '')), 'To-do not found.');
      return todos.updateTodo(current.id, validateTodo({
        title: current.title,
        dueDate: current.dueDate,
        subtasks: current.subtasks,
        completed: args.completed === undefined ? true : Boolean(args.completed),
      }));
    },
    delete_todo: (args) => ({
      deleted: requireResult(todos.deleteTodo(String(args.id || '')), 'To-do not found.'),
      id: String(args.id || ''),
    }),
    clear_completed_todos: () => ({ deleted: todos.clearCompleted() }),
    list_notes: (args) => listNotes(database, args),
    get_note: (args) => requireResult(database.getNote(String(args.id || '')), 'Note not found.'),
    get_block: (args) => requireResult(database.getBlock(validateBlockCode(args.code)), 'Active block not found.'),
    update_block: (args) => requireResult(database.updateBlock(validateBlockCode(args.code), {
      content: args.content,
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.language !== undefined ? { language: args.language } : {}),
    }), 'Active block not found.'),
    create_note: (args) => createNote(database, args),
    update_note: (args) => updateNote(database, args),
    delete_note: (args) => ({
      deleted: requireResult(database.softDelete(String(args.id || '')), 'Active note not found.'),
      id: String(args.id || ''),
    }),
    restore_note: (args) => {
      const id = String(args.id || '');
      requireResult(database.restoreNote(id), 'Deleted note not found.');
      return database.getNote(id);
    },
    list_categories: () => database.listCategories(),
    create_category: (args) => database.createCategory(validateCategoryName(args.name)),
    rename_category: (args) => requireResult(
      database.renameCategory(Number(args.id), validateCategoryName(args.name)),
      'Category not found.',
    ),
    delete_category: (args) => ({
      deleted: requireResult(database.deleteCategory(Number(args.id)), 'Category not found.'),
      id: Number(args.id),
    }),
  };
}

function asToolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: { result: value },
  };
}

function asToolError(error) {
  const message = error?.message || 'Tool call failed.';
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export function createLambdaMcpServer(database, todos) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const handlers = toolHandlers(database, todos);

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return asToolResult(await handlers[tool.name](args || {}));
        } catch (error) {
          return asToolError(error);
        }
      },
    );
  }

  return server;
}

export function createLambdaMcpNodeHandler(database, todos) {
  const handler = createMcpHandler(
    () => createLambdaMcpServer(database, todos),
    { legacy: 'stateless' },
  );
  return toNodeHandler(handler);
}
