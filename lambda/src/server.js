import http from 'node:http';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apiKeyMatches, AuthManager } from './auth.js';
import { loadConfig } from './config.js';
import { SnippetDatabase } from './database.js';
import { EncryptionVault } from './encryption.js';
import { createLambdaMcpNodeHandler } from './mcp.js';
import { TodoStore } from './todo-store.js';
import { BookmarkStore } from './bookmark-store.js';
import { ValidationError, validateBackup, validateBlockCode, validateBookmark, validateCategoryName, validateNote, validateTodo } from './validation.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function empty(response, status = 204, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), 'Cache-Control': 'no-store', ...headers });
  response.end();
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function readJsonObject(request) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object.');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

async function readBlockUpdate(request) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) return readJsonObject(request);
  const content = (await readBody(request)).toString('utf8');
  return contentType.includes('text/csv') ? { type: 'csv', content } : { content };
}

function downloadFilename(value) {
  const cleaned = String(value || 'attachment').replace(/[\r\n]/g, '').slice(0, 255) || 'attachment';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleaned)}`;
}

function withBlockTools(contents) {
  const html = contents.toString('utf8');
  if (html.includes('todo-tools.js')) return contents;
  return Buffer.from(html
    .replace('</head>', '  <link rel="stylesheet" href="block-tools.css?v=1.3.8">\n  <link rel="stylesheet" href="todo-tools.css?v=1.3.8">\n  <link rel="stylesheet" href="bookmark-tools.css?v=1.3.8">\n</head>')
    .replace('</body>', '  <script type="module" src="block-tools.js?v=1.3.10"></script>\n  <script type="module" src="todo-tools.js?v=1.3.7"></script>\n  <script type="module" src="bookmark-tools.js?v=1.3.8"></script>\n</body>'));
}

function serveFile(response, filename) {
  const extension = path.extname(filename).toLowerCase();
  try {
    let contents = fs.readFileSync(filename);
    if (path.basename(filename) === 'index.html') contents = withBlockTools(contents);
    response.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' || extension === '.webmanifest'
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    response.end(contents);
  } catch {
    json(response, 404, { error: 'Not found.' });
  }
}

function staticFilename(pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  return resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) || resolved === path.join(PUBLIC_DIR, 'index.html')
    ? resolved
    : null;
}

function normalizedTodoInput(body, current = null) {
  const has = (key) => Object.hasOwn(body, key);
  return validateTodo({
    title: has('title') ? body.title : current?.title,
    dueDate: has('dueDate') ? body.dueDate : (has('due_date') ? body.due_date : current?.dueDate),
    subtasks: has('subtasks') ? body.subtasks : (current?.subtasks || []),
    completed: has('completed') ? body.completed : Boolean(current?.completed),
  });
}

function bookmarkFallbackTitle(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '') || 'Untitled bookmark'; }
  catch { return 'Untitled bookmark'; }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const value = String(address).toLowerCase();
  return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
}

async function assertPublicUrl(value) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) throw new ValidationError('URLs on local or private networks cannot be fetched.');
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new ValidationError('URLs on local or private networks cannot be fetched.');
  return parsed;
}

function titleFromHtml(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300) || '';
}

export async function fetchBookmarkTitle(value) {
  let current = String(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Lambda Bookmarks/1.0' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { current = new URL(response.headers.get('location'), current).toString(); continue; }
    if (!response.ok) throw new Error(`The page returned ${response.status}.`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 1_000_000) throw new Error('The page is too large to read a title from.');
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 1_000_000) { await reader.cancel(); throw new Error('The page is too large to read a title from.'); }
      chunks.push(chunk);
    }
    return titleFromHtml(new TextDecoder().decode(Buffer.concat(chunks))) || bookmarkFallbackTitle(current);
  }
  throw new Error('The page redirected too many times.');
}

function normalizedBookmarkInput(body, current = null, title = '') {
  const has = (key) => Object.hasOwn(body, key);
  const requestedTitle = has('title') ? String(body.title || '').trim() : '';
  return validateBookmark({ url: has('url') ? body.url : current?.url, title: requestedTitle || current?.title || title, tags: has('tags') ? body.tags : (current?.tags || []) });
}

function todoSummaryDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

function logMcpRequest(request, response) {
  const protocol = String(request.headers['mcp-protocol-version'] || 'legacy/negotiating');
  const method = String(request.headers['mcp-method'] || request.method || 'unknown');
  const tool = String(request.headers['mcp-name'] || '');
  response.once('finish', () => {
    const toolPart = tool ? ` tool=${tool}` : '';
    console.log(`[Lambda MCP] ${method} protocol=${protocol}${toolPart} status=${response.statusCode}`);
  });
}

export function createApp(customConfig = {}) {
  const config = { ...loadConfig(), ...customConfig };
  const encryptionKeyPath = customConfig.encryptionKeyPath
    || (customConfig.database || config.dbPath === ':memory:' ? '' : `${config.dbPath}.encryption.json`);
  const encryption = customConfig.encryption || new EncryptionVault(config.password, encryptionKeyPath);
  const database = customConfig.database || new SnippetDatabase(config.dbPath, encryption);
  const todos = customConfig.todos || new TodoStore(database.db, encryption);
  const bookmarks = customConfig.bookmarks || new BookmarkStore(database.db, encryption);
  const bookmarkTitleFetcher = customConfig.bookmarkTitleFetcher || fetchBookmarkTitle;
  const auth = new AuthManager(config.password, config.sessionDays, database.sessions);
  const mcpHandler = createLambdaMcpNodeHandler(database, todos);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (pathname === '/health' && request.method === 'GET') {
        return json(response, 200, { status: 'ok' });
      }

      if (pathname === '/mcp') {
        if (!config.apiKey) {
          return json(response, 503, { error: 'MCP is disabled until an API key is configured.' });
        }
        if (!apiKeyMatches(request, config.apiKey)) {
          return json(response, 401, { error: 'A valid API key is required.' }, {
            'WWW-Authenticate': 'Bearer realm="Lambda MCP"',
          });
        }
        logMcpRequest(request, response);
        await mcpHandler(request, response);
        return;
      }

      if (pathname === '/api/auth/status' && request.method === 'GET') {
        const token = auth.authenticate(request);
        return json(response, 200, { authenticated: Boolean(token) }, token ? {
          'Set-Cookie': auth.cookie(token, request, config.cookieSecure),
        } : {});
      }

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        if (!auth.canAttempt(request)) {
          return json(response, 429, { error: 'Too many attempts. Try again in a few minutes.' });
        }
        const body = await readJsonObject(request);
        if (!auth.passwordMatches(body.password || '')) {
          auth.recordFailure(request);
          return json(response, 401, { error: 'That password is not correct.' });
        }
        auth.clearFailures(request);
        const token = auth.createSession();
        return json(response, 200, { authenticated: true }, {
          'Set-Cookie': auth.cookie(token, request, config.cookieSecure),
        });
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        auth.destroySession(request);
        return empty(response, 204, {
          'Set-Cookie': auth.expiredCookie(request, config.cookieSecure),
        });
      }

      const sessionToken = pathname.startsWith('/api/') ? auth.authenticate(request) : null;
      if (pathname.startsWith('/api/') && !sessionToken && !apiKeyMatches(request, config.apiKey)) {
        return json(response, 401, { error: 'Authentication required.' }, {
          'WWW-Authenticate': 'Bearer realm="Lambda API"',
        });
      }
      if (sessionToken) response.setHeader('Set-Cookie', auth.cookie(sessionToken, request, config.cookieSecure));

      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        const trash = [
          ...database.listNotes({ deleted: true }).map((note) => ({ ...note, type: 'note' })),
          ...todos.listTodos({ deletedOnly: true }).map((todo) => ({ ...todo, type: 'todo' })),
          ...bookmarks.listBookmarks({ deletedOnly: true }).map((bookmark) => ({ ...bookmark, type: 'bookmark' })),
        ].sort((left, right) => String(right.deletedAt || '').localeCompare(String(left.deletedAt || '')));
        return json(response, 200, {
          notes: database.listNotes(),
          trash,
          categories: database.listCategories(),
          todos: todos.listTodos(),
          bookmarks: bookmarks.listBookmarks(),
          cachedAt: new Date().toISOString(),
        });
      }

      if (pathname === '/api/backup' && request.method === 'GET') {
        const date = new Date().toISOString().slice(0, 10);
        return json(response, 200, { ...database.exportBackup(), todos: todos.exportBackup(), bookmarks: bookmarks.exportBackup() }, {
          'Content-Disposition': downloadFilename(`lambda-backup-${date}.json`),
        });
      }

      if (pathname === '/api/backup' && request.method === 'PUT') {
        const backup = validateBackup(await readJsonObject(request));
        const restored = database.restoreBackup(backup);
        const restoredTodos = todos.restoreBackup(backup.todos);
        const restoredBookmarks = bookmarks.restoreBackup(backup.bookmarks);
        return json(response, 200, { ...restored, todos: restoredTodos, ...restoredBookmarks });
      }

      if (pathname === '/api/attachments' && request.method === 'POST') {
        const declaredSize = Number(request.headers['content-length'] || 0);
        if (declaredSize > MAX_ATTACHMENT_BYTES) {
          const error = new Error('Attachments must be 25 MB or smaller.');
          error.statusCode = 413;
          throw error;
        }
        let name;
        try { name = decodeURIComponent(String(request.headers['x-file-name'] || 'attachment')); }
        catch {
          const error = new Error('Attachment name is invalid.');
          error.statusCode = 400;
          throw error;
        }
        name = name.trim();
        if (!name || name.length > 255 || /[\r\n]/.test(name)) {
          const error = new Error('Attachment name is invalid.');
          error.statusCode = 400;
          throw error;
        }
        const contents = await readBody(request, MAX_ATTACHMENT_BYTES);
        const id = randomUUID();
        const encrypted = encryption.encryptBytes(contents, `lambda:attachment:${id}:v1`);
        fs.mkdirSync(config.attachmentDir, { recursive: true });
        fs.writeFileSync(path.join(config.attachmentDir, id), encrypted, { flag: 'wx', mode: 0o600 });
        return json(response, 201, {
          id,
          name,
          size: contents.length,
          mime: String(request.headers['content-type'] || 'application/octet-stream').slice(0, 120),
        });
      }

      const attachmentMatch = pathname.match(/^\/api\/attachments\/([a-f0-9-]{36})$/i);
      if (attachmentMatch && request.method === 'GET') {
        const id = attachmentMatch[1].toLowerCase();
        const filename = path.join(config.attachmentDir, id);
        if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
          return json(response, 404, { error: 'Attachment not found.' });
        }
        const contents = encryption.decryptBytes(fs.readFileSync(filename), `lambda:attachment:${id}:v1`);
        response.writeHead(200, {
          ...securityHeaders(),
          'Content-Type': 'application/octet-stream',
          'Content-Length': contents.length,
          'Content-Disposition': downloadFilename(url.searchParams.get('name')),
          'Cache-Control': 'private, max-age=3600',
        });
        return response.end(contents);
      }

      const blockMatch = pathname.match(/^\/api\/blocks\/([a-z0-9]{5})$/i);
      if (blockMatch && request.method === 'GET') {
        const block = database.getBlock(validateBlockCode(blockMatch[1]));
        return block ? json(response, 200, block) : json(response, 404, { error: 'Active block not found.' });
      }
      if (blockMatch && ['PATCH', 'PUT'].includes(request.method)) {
        const block = database.updateBlock(validateBlockCode(blockMatch[1]), await readBlockUpdate(request));
        return block ? json(response, 200, block) : json(response, 404, { error: 'Active block not found.' });
      }

      if (pathname === '/api/todos/count' && request.method === 'GET') {
        return json(response, 200, { active: todos.countActive() });
      }

      if (pathname === '/api/todos/summary' && request.method === 'GET') {
        const date = todoSummaryDate(url.searchParams.get('date') || new Date().toISOString().slice(0, 10));
        if (!date) return json(response, 400, { error: 'date must use YYYY-MM-DD.' });
        return json(response, 200, { date, ...todos.summaryForDate(date) });
      }

      if (pathname === '/api/todos/order' && request.method === 'PUT') {
        const body = await readJsonObject(request);
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
          return json(response, 400, { error: 'ids must be a list of to-do IDs.' });
        }
        return json(response, 200, todos.reorderActive(body.ids));
      }

      if (pathname === '/api/todos' && request.method === 'GET') {
        return json(response, 200, todos.listTodos({
          includeCompleted: url.searchParams.get('include_completed') === '1',
          completedOnly: url.searchParams.get('completed') === '1',
          includeDeleted: url.searchParams.get('include_deleted') === '1',
          deletedOnly: url.searchParams.get('trash') === '1',
          search: url.searchParams.get('q') || '',
        }));
      }

      if (pathname === '/api/todos' && request.method === 'POST') {
        const body = await readJsonObject(request);
        return json(response, 201, todos.createTodo(normalizedTodoInput(body)));
      }

      if (pathname === '/api/todos/completed' && request.method === 'DELETE') {
        return json(response, 200, { deleted: todos.clearCompleted() });
      }

      if (pathname === '/api/bookmarks' && request.method === 'GET') {
        return json(response, 200, bookmarks.listBookmarks({
          tag: url.searchParams.get('tag') || '',
          search: url.searchParams.get('q') || '',
          includeDeleted: url.searchParams.get('include_deleted') === '1',
          deletedOnly: url.searchParams.get('trash') === '1',
        }));
      }
      if (pathname === '/api/bookmarks' && request.method === 'POST') {
        const body = await readJsonObject(request);
        const preliminary = validateBookmark({ ...body, title: String(body.title || '').trim() || 'Untitled bookmark' });
        let title = String(body.title || '').trim();
        if (!title) {
          try {
            title = await bookmarkTitleFetcher(preliminary.url);
          } catch (error) {
            console.warn(`Could not fetch bookmark title for ${preliminary.url}: ${error.message}`);
            title = bookmarkFallbackTitle(preliminary.url);
          }
        }
        return json(response, 201, bookmarks.createBookmark(normalizedBookmarkInput({ ...body, url: preliminary.url }, null, title)));
      }
      const bookmarkMatch = pathname.match(/^\/api\/bookmarks\/([a-f0-9-]+)$/i);
      if (bookmarkMatch && request.method === 'GET') {
        const bookmark = bookmarks.getBookmark(bookmarkMatch[1]);
        return bookmark ? json(response, 200, bookmark) : json(response, 404, { error: 'Bookmark not found.' });
      }
      if (bookmarkMatch && ['PATCH', 'PUT'].includes(request.method)) {
        const current = bookmarks.getBookmark(bookmarkMatch[1]);
        if (!current) return json(response, 404, { error: 'Bookmark not found.' });
        return json(response, 200, bookmarks.updateBookmark(bookmarkMatch[1], normalizedBookmarkInput(await readJsonObject(request), current)));
      }
      if (bookmarkMatch && request.method === 'DELETE') {
        return bookmarks.deleteBookmark(bookmarkMatch[1]) ? empty(response) : json(response, 404, { error: 'Bookmark not found.' });
      }
      const bookmarkActionMatch = pathname.match(/^\/api\/bookmarks\/([a-f0-9-]+)\/(restore|permanent)$/i);
      if (bookmarkActionMatch && bookmarkActionMatch[2] === 'restore' && request.method === 'POST') {
        return bookmarks.restoreBookmark(bookmarkActionMatch[1]) ? json(response, 200, bookmarks.getBookmark(bookmarkActionMatch[1])) : json(response, 404, { error: 'Deleted bookmark not found.' });
      }
      if (bookmarkActionMatch && bookmarkActionMatch[2] === 'permanent' && request.method === 'DELETE') {
        return bookmarks.permanentlyDeleteBookmark(bookmarkActionMatch[1]) ? empty(response) : json(response, 404, { error: 'Deleted bookmark not found.' });
      }

      const todoMatch = pathname.match(/^\/api\/todos\/([a-f0-9-]+)$/i);
      if (todoMatch && request.method === 'GET') {
        const todo = todos.getTodo(todoMatch[1]);
        return todo ? json(response, 200, todo) : json(response, 404, { error: 'To-do not found.' });
      }
      if (todoMatch && request.method === 'PUT') {
        const body = await readJsonObject(request);
        const todo = todos.updateTodo(todoMatch[1], normalizedTodoInput(body));
        return todo ? json(response, 200, todo) : json(response, 404, { error: 'To-do not found.' });
      }
      if (todoMatch && request.method === 'PATCH') {
        const current = todos.getTodo(todoMatch[1]);
        if (!current) return json(response, 404, { error: 'To-do not found.' });
        const body = await readJsonObject(request);
        return json(response, 200, todos.updateTodo(todoMatch[1], normalizedTodoInput(body, current)));
      }
      if (todoMatch && request.method === 'DELETE') {
        return todos.deleteTodo(todoMatch[1]) ? empty(response) : json(response, 404, { error: 'To-do not found.' });
      }
      const todoActionMatch = pathname.match(/^\/api\/todos\/([a-f0-9-]+)\/(restore|permanent)$/i);
      if (todoActionMatch && todoActionMatch[2] === 'restore' && request.method === 'POST') {
        return todos.restoreTodo(todoActionMatch[1]) ? json(response, 200, todos.getTodo(todoActionMatch[1])) : json(response, 404, { error: 'Deleted to-do not found.' });
      }
      if (todoActionMatch && todoActionMatch[2] === 'permanent' && request.method === 'DELETE') {
        return todos.permanentlyDeleteTodo(todoActionMatch[1]) ? empty(response) : json(response, 404, { error: 'Deleted to-do not found.' });
      }

      if (pathname === '/api/notes' && request.method === 'GET') {
        return json(response, 200, database.listNotes({
          deleted: url.searchParams.get('trash') === '1',
          category: url.searchParams.get('category') || '',
          tag: url.searchParams.get('tag') || '',
          search: url.searchParams.get('q') || '',
        }));
      }

      if (pathname === '/api/notes' && request.method === 'POST') {
        const note = validateNote(await readJson(request));
        return json(response, 201, database.createNote(note));
      }

      if (pathname === '/api/categories' && request.method === 'GET') return json(response, 200, database.listCategories());
      if (pathname === '/api/categories' && request.method === 'POST') {
        const body = await readJsonObject(request);
        return json(response, 201, database.createCategory(validateCategoryName(body.name)));
      }

      const categoryMatch = pathname.match(/^\/api\/categories\/(\d+)$/);
      if (categoryMatch && request.method === 'PATCH') {
        const body = await readJsonObject(request);
        const category = database.renameCategory(Number(categoryMatch[1]), validateCategoryName(body.name));
        return category ? json(response, 200, category) : json(response, 404, { error: 'Category not found.' });
      }
      if (categoryMatch && request.method === 'DELETE') {
        return database.deleteCategory(Number(categoryMatch[1])) ? empty(response) : json(response, 404, { error: 'Category not found.' });
      }

      const versionMatch = pathname.match(/^\/api\/notes\/([a-f0-9-]+)\/versions(?:\/(\d+)\/restore)?$/i);
      if (versionMatch && request.method === 'GET' && !versionMatch[2]) {
        if (!database.getNote(versionMatch[1])) return json(response, 404, { error: 'Note not found.' });
        return json(response, 200, database.listVersions(versionMatch[1]));
      }
      if (versionMatch && request.method === 'POST' && versionMatch[2]) {
        const restored = database.restoreVersion(versionMatch[1], Number(versionMatch[2]));
        return restored ? json(response, 200, restored) : json(response, 404, { error: 'Note or version not found.' });
      }

      const actionMatch = pathname.match(/^\/api\/notes\/([a-f0-9-]+)\/(restore|permanent)$/i);
      if (actionMatch && actionMatch[2] === 'restore' && request.method === 'POST') {
        return database.restoreNote(actionMatch[1]) ? json(response, 200, database.getNote(actionMatch[1])) : json(response, 404, { error: 'Deleted note not found.' });
      }
      if (actionMatch && actionMatch[2] === 'permanent' && request.method === 'DELETE') {
        return database.permanentlyDelete(actionMatch[1]) ? empty(response) : json(response, 404, { error: 'Deleted note not found.' });
      }

      const noteMatch = pathname.match(/^\/api\/notes\/([a-f0-9-]+)$/i);
      if (noteMatch && request.method === 'GET') {
        const note = database.getNote(noteMatch[1]);
        return note ? json(response, 200, note) : json(response, 404, { error: 'Note not found.' });
      }
      if (noteMatch && request.method === 'PUT') {
        const note = database.updateNote(noteMatch[1], validateNote(await readJson(request), { partial: true }));
        return note ? json(response, 200, note) : json(response, 404, { error: 'Active note not found.' });
      }
      if (noteMatch && request.method === 'PATCH') {
        const current = database.getNote(noteMatch[1]);
        if (!current || current.deletedAt) return json(response, 404, { error: 'Active note not found.' });
        const body = await readJsonObject(request);
        const has = (key) => Object.hasOwn(body, key);
        const note = database.updateNote(noteMatch[1], validateNote({
          title: has('title') ? body.title : current.title,
          category: has('category') ? body.category : current.category,
          tags: has('tags') ? body.tags : current.tags,
          blocks: has('blocks') ? body.blocks : current.blocks,
          versionToken: has('versionToken') ? body.versionToken : randomUUID(),
        }));
        return json(response, 200, note);
      }
      if (noteMatch && request.method === 'DELETE') {
        return database.softDelete(noteMatch[1]) ? empty(response) : json(response, 404, { error: 'Active note not found.' });
      }

      if (pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found.' });
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });

      const filename = staticFilename(pathname);
      if (filename && fs.existsSync(filename) && fs.statSync(filename).isFile()) return serveFile(response, filename);
      return serveFile(response, path.join(PUBLIC_DIR, 'index.html'));
    } catch (error) {
      const status = error instanceof ValidationError ? 400 : (error.statusCode || 500);
      if (status === 500) console.error(error);
      return json(response, status, { error: status === 500 ? 'An unexpected error occurred.' : error.message });
    }
  });

  return {
    server,
    database,
    todos,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, resolve)),
    close: () => new Promise((resolve, reject) => server.close((error) => {
      if (customConfig.database) return error ? reject(error) : resolve();
      database.close();
      return error ? reject(error) : resolve();
    })),
    config,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const app = createApp();
  await app.listen();
  console.log(`Lambda is listening on http://${app.config.host}:${app.config.port}`);
  if (app.config.password === 'changeme') console.warn('WARNING: Using the default password. Set APP_PASSWORD or configure the add-on password.');
}
