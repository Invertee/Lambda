import { randomUUID } from 'node:crypto';
import { validateBlockCode, validateCategoryName, validateNote } from './validation.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];

const blockSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Optional stable block ID.' },
    code: { type: 'string', pattern: '^[A-Za-z0-9]{5}$', description: 'Server-assigned five-character block code.' },
    type: { type: 'string', enum: ['text', 'heading', 'code', 'csv'], description: 'Block type.' },
    content: { type: 'string', description: 'Block text, source code, or CSV content.' },
    language: { type: 'string', description: 'Language identifier for a code block.' },
    level: { type: 'integer', minimum: 1, maximum: 3, description: 'Heading level.' },
  },
  required: ['type', 'content'],
};

const noteFields = {
  title: { type: 'string', maxLength: 200, description: 'Human-readable note title.' },
  category: { type: 'string', maxLength: 80, description: 'Category name. It is created automatically if needed.' },
  tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
  blocks: { type: 'array', maxItems: 100, items: blockSchema, description: 'Complete ordered block list.' },
  content: { type: 'string', description: 'Convenience alternative to blocks for a single text, code, heading, or CSV block.' },
  content_type: { type: 'string', enum: ['text', 'heading', 'code', 'csv'], description: 'Type used with content. Defaults to text.' },
  language: { type: 'string', description: 'Language used when content_type is code.' },
};

export const MCP_TOOLS = [
  {
    name: 'list_notes',
    title: 'List and search notes',
    description: 'List notes ordered by most recently updated, optionally filtering by full-text query, category, tag, or block code.',
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
    description: 'Replace the content of an active text, heading, code, or CSV block using its five-character code. Set type to csv when supplying CSV table data.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[A-Za-z0-9]{5}$' },
        content: { type: 'string' },
        type: { type: 'string', enum: ['text', 'heading', 'code', 'csv'] },
        language: { type: 'string' },
        level: { type: 'integer', minimum: 1, maximum: 3 },
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
    description: 'Restore a soft-deleted note from the recycle bin.',
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
  if (type === 'heading') block.level = 2;
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
  const updated = validateNote({
    title: has('title') ? args.title : current.title,
    category: has('category') ? args.category : current.category,
    tags: has('tags') ? args.tags : current.tags,
    blocks: has('blocks') ? args.blocks : (usesContent ? blocksFromArguments(args) : current.blocks),
    versionToken: randomUUID(),
  });
  return database.updateNote(current.id, updated);
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

const toolHandlers = {
  list_notes: (database, args) => listNotes(database, args),
  get_note: (database, args) => requireResult(database.getNote(String(args.id || '')), 'Note not found.'),
  get_block: (database, args) => requireResult(database.getBlock(validateBlockCode(args.code)), 'Active block not found.'),
  update_block: (database, args) => requireResult(database.updateBlock(validateBlockCode(args.code), {
    content: args.content,
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.language !== undefined ? { language: args.language } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
  }), 'Active block not found.'),
  create_note: createNote,
  update_note: updateNote,
  delete_note: (database, args) => ({ deleted: requireResult(database.softDelete(String(args.id || '')), 'Active note not found.'), id: args.id }),
  restore_note: (database, args) => {
    requireResult(database.restoreNote(String(args.id || '')), 'Deleted note not found.');
    return database.getNote(String(args.id));
  },
  list_categories: (database) => database.listCategories(),
  create_category: (database, args) => database.createCategory(validateCategoryName(args.name)),
  rename_category: (database, args) => requireResult(
    database.renameCategory(Number(args.id), validateCategoryName(args.name)),
    'Category not found.',
  ),
  delete_category: (database, args) => ({
    deleted: requireResult(database.deleteCategory(Number(args.id)), 'Category not found.'),
    id: Number(args.id),
  }),
};

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function protocolError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value, isError = false) {
  const structuredContent = isError ? { error: String(value) } : { result: value };
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

export function processMcpMessage(database, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { status: 400, body: protocolError(message?.id, -32600, 'Invalid Request') };
  }

  if (message.method === 'notifications/initialized') return { status: 202, body: null };

  if (message.method === 'server/discover') {
    return {
      status: 200,
      body: result(message.id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: 'lambda-notes', version: '1.2.0' },
        instructions: 'Use note and block tools to search, create, update, categorise, soft-delete, restore, and address individual Lambda blocks by code.',
      }),
    };
  }

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const protocolVersion = LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: result(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lambda-notes', version: '1.2.0' },
        instructions: 'Use note and block tools to search, create, update, categorise, soft-delete, restore, and address individual Lambda blocks by code.',
      }),
    };
  }

  if (message.method === 'ping') return { status: 200, body: result(message.id, {}) };

  if (message.method === 'tools/list') {
    return {
      status: 200,
      body: result(message.id, {
        resultType: 'complete',
        tools: MCP_TOOLS,
        ttlMs: 300_000,
        cacheScope: 'public',
      }),
    };
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const handler = toolHandlers[name];
    if (!handler) return { status: 400, body: protocolError(message.id, -32602, `Unknown tool: ${String(name || '')}`) };
    const args = message.params?.arguments;
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
      return { status: 400, body: protocolError(message.id, -32602, 'Tool arguments must be an object.') };
    }
    try {
      return { status: 200, body: result(message.id, toolResult(handler(database, args || {}))) };
    } catch (error) {
      return { status: 200, body: result(message.id, toolResult(error.message || 'Tool call failed.', true)) };
    }
  }

  return { status: 404, body: protocolError(message.id, -32601, 'Method not found') };
}
