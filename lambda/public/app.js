const APP_BASE = new URL('.', import.meta.url);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = () => crypto.randomUUID?.() || `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;

const icons = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v11h-17z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9l4 4v13H6z"/><path d="M15 3.5v4h4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
  restore: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m7 14 5-5 5 5"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r=".7"/><circle cx="15" cy="7" r=".7"/><circle cx="9" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/><circle cx="9" cy="17" r=".7"/><circle cx="15" cy="17" r=".7"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 5"/></svg>',
  attachment: '<svg viewBox="0 0 24 24"><path d="m9 12 5.5-5.5a3 3 0 0 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.5-7.5"/></svg>',
};

const LANGUAGES = [
  { id: 'powershell', label: 'PowerShell', extension: 'ps1' },
  { id: 'bash', label: 'Bash', extension: 'sh' },
  { id: 'shell', label: 'Shell', extension: 'sh' },
  { id: 'javascript', label: 'JavaScript', extension: 'js' },
  { id: 'js', label: 'JavaScript (JS)', extension: 'js' },
  { id: 'typescript', label: 'TypeScript', extension: 'ts' },
  { id: 'python', label: 'Python', extension: 'py' },
  { id: 'json', label: 'JSON', extension: 'json' },
  { id: 'yaml', label: 'YAML', extension: 'yaml' },
  { id: 'sql', label: 'SQL', extension: 'sql' },
  { id: 'html', label: 'HTML', extension: 'html' },
  { id: 'css', label: 'CSS', extension: 'css' },
  { id: 'csharp', label: 'C#', extension: 'cs' },
  { id: 'plaintext', label: 'Plain text', extension: 'txt' },
];

const state = {
  notes: [],
  trash: [],
  categories: [],
  selectedId: null,
  currentNote: null,
  filter: { type: 'all', value: null },
  search: '',
  view: 'library',
  offline: false,
  versionToken: uuid(),
  versionTokenAt: Date.now(),
};

let saveTimer = null;
let saveInFlight = null;
let editGeneration = 0;
let savedGeneration = 0;
let draggedBlockId = null;
let confirmResolver = null;

function apiUrl(path = '') {
  return new URL(`api/${path.replace(/^\//, '')}`, APP_BASE);
}

async function downloadBackup() {
  const button = $('#export-backup');
  button.disabled = true;
  try {
    if (editGeneration !== savedGeneration) await saveNow();
    const response = await fetch(apiUrl('backup'));
    if (response.status === 401) {
      showLogin('Your session has ended. Unlock Lambda to continue.');
      throw new Error('Authentication required.');
    }
    if (!response.ok) throw new Error(`Backup failed (${response.status}).`);

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'lambda-backup.json';
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    toast('Backup exported.');
  } catch (error) {
    if (error.message !== 'Authentication required.') toast(error.message || 'Backup could not be exported.', 'error');
  } finally {
    button.disabled = state.offline;
  }
}

async function importBackup(file) {
  const button = $('#import-backup');
  button.disabled = true;
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error('Backup files must be 12 MB or smaller.');
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error('The selected file is not valid JSON.'); }
    if (backup?.format !== 'lambda-backup' || backup?.version !== 1) {
      throw new Error('The selected file is not a supported Lambda backup.');
    }
    const accepted = await confirmAction(
      'Replace all Lambda data?',
      'Importing this backup will permanently replace every current note, recycled note, category, tag and version. This cannot be undone.',
      'Import and replace',
    );
    if (!accepted) return;
    if (editGeneration !== savedGeneration) await saveNow();
    await api('backup', { method: 'PUT', body: JSON.stringify(backup) });
    const snapshot = await api('bootstrap');
    applySnapshot(snapshot);
    state.selectedId = null;
    state.currentNote = null;
    state.filter = { type: 'all', value: null };
    state.search = '';
    state.view = 'library';
    editGeneration = 0;
    savedGeneration = 0;
    await cacheSnapshot(snapshot);
    if ($('#settings-dialog').open) $('#settings-dialog').close();
    showApp();
    toast('Backup imported.');
  } catch (error) {
    if (error.message !== 'Authentication required.') toast(error.message || 'Backup could not be imported.', 'error');
  } finally {
    $('#backup-picker').value = '';
    button.disabled = state.offline;
  }
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  if (response.status === 401) {
    showLogin('Your session has ended. Unlock Lambda to continue.');
    throw new Error('Authentication required.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lambda-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('cache');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function cacheSnapshot(snapshot = null) {
  if (!('indexedDB' in window)) return;
  const value = snapshot || {
    notes: state.notes,
    trash: state.trash,
    categories: state.categories,
    cachedAt: new Date().toISOString(),
  };
  try {
    const db = await openOfflineDb();
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').put(value, 'snapshot');
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn('Could not update the offline cache.', error);
  }
}

async function readCachedSnapshot() {
  if (!('indexedDB' in window)) return null;
  try {
    const db = await openOfflineDb();
    const tx = db.transaction('cache', 'readonly');
    const request = tx.objectStore('cache').get('snapshot');
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

function applySnapshot(snapshot) {
  state.notes = snapshot.notes || [];
  state.trash = snapshot.trash || [];
  state.categories = snapshot.categories || [];
}

function showLogin(message = '') {
  clearTimeout(saveTimer);
  $('#app-shell').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-error').textContent = message;
  setTimeout(() => $('#password').focus(), 0);
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  updateConnectionUi();
  renderSidebar();
  if (state.notes.length) {
    if (state.view === 'library') showLibrary({ skipSave: true });
    else {
      const wanted = state.notes.find((note) => note.id === state.selectedId) || state.notes[0];
      selectNote(wanted.id, { skipSave: true });
    }
  } else {
    showEmptyState();
  }
}

async function boot() {
  wireEvents();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('sw.js', APP_BASE)).catch((error) => console.warn('Service worker unavailable.', error));
  }

  try {
    const status = await api('auth/status');
    if (!status.authenticated) return showLogin();
    const snapshot = await api('bootstrap');
    applySnapshot(snapshot);
    state.offline = false;
    await cacheSnapshot(snapshot);
    showApp();
  } catch (error) {
    if (error.message === 'Authentication required.') return;
    const cached = await readCachedSnapshot();
    if (cached) {
      applySnapshot(cached);
      state.offline = true;
      showApp();
      toast('Offline copy loaded. Editing is paused until the server returns.');
    } else {
      showLogin('The server is unavailable and there is no offline copy yet.');
    }
  }
}

function updateConnectionUi() {
  $('#offline-banner').classList.toggle('hidden', !state.offline);
  $('#connection-icon').classList.toggle('offline', state.offline);
  $('#connection-text').textContent = state.offline ? 'Offline copy' : 'Synced';
  $('#new-note').disabled = state.offline;
  $('#mobile-new-note').disabled = state.offline;
  $('#empty-new-note').disabled = state.offline;
  $('#manage-categories').disabled = state.offline;
  $('#settings-categories').disabled = state.offline;
  $('#export-backup').disabled = state.offline;
  $('#import-backup').disabled = state.offline;
  if (state.currentNote) setEditorDisabled(state.offline);
}

function setEditorDisabled(disabled) {
  $$('#note-editor input, #note-editor textarea, #note-editor select, #note-editor button').forEach((element) => {
    element.disabled = disabled;
  });
}

function formatRelative(dateString) {
  const date = new Date(dateString);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const ranges = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, amount] of ranges) {
    if (Math.abs(seconds) >= amount) return formatter.format(Math.round(seconds / amount), unit);
  }
  return 'just now';
}

function searchableText(note) {
  return [
    note.title,
    note.category || '',
    ...(note.tags || []),
    ...(note.blocks || []).map((block) => `${block.content || ''} ${block.language || ''} ${block.alt || ''} ${block.name || ''}`),
  ].join(' ').toLocaleLowerCase();
}

function filteredNotes() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.notes.filter((note) => {
    if (query && !searchableText(note).includes(query)) return false;
    if (state.filter.type === 'category' && note.category !== state.filter.value) return false;
    if (state.filter.type === 'tag' && !note.tags.includes(state.filter.value)) return false;
    return true;
  });
}

function renderSidebar() {
  $('#all-count').textContent = state.notes.length;
  $('#trash-count').textContent = state.trash.length;

  $$('.filter-nav .nav-item[data-filter]').forEach((button) => {
    button.classList.toggle('active', state.view !== 'trash' && state.filter.type === button.dataset.filter);
  });
  $('#trash-nav').classList.toggle('active', state.view === 'trash');

  const categoryList = $('#categories-list');
  categoryList.replaceChildren(...state.categories.map((category) => {
    const button = document.createElement('button');
    button.className = 'nav-item';
    if (state.view !== 'trash' && state.filter.type === 'category' && state.filter.value === category.name) button.classList.add('active');
    button.dataset.category = category.name;
    const label = document.createElement('span');
    label.innerHTML = icons.folder;
    label.append(document.createTextNode(category.name));
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = state.notes.filter((note) => note.category === category.name).length;
    button.append(label, count);
    return button;
  }));

  const tagCounts = new Map();
  state.notes.forEach((note) => note.tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)));
  const tags = [...tagCounts].sort((a, b) => a[0].localeCompare(b[0]));
  $('#tag-section').classList.toggle('hidden', tags.length === 0);
  $('#tag-list').replaceChildren(...tags.map(([tag, count]) => {
    const button = document.createElement('button');
    button.className = 'sidebar-tag';
    if (state.filter.type === 'tag' && state.filter.value === tag) button.classList.add('active');
    button.dataset.tag = tag;
    button.textContent = `#${tag} · ${count}`;
    return button;
  }));

  const notes = state.notes.slice(0, 6);
  $('#note-list-label').textContent = 'Recent notes';
  if (!notes.length) {
    const empty = document.createElement('p');
    empty.className = 'note-list-empty';
    empty.textContent = 'No recent notes yet.';
    $('#note-list').replaceChildren(empty);
  } else {
    $('#note-list').replaceChildren(...notes.map((note) => {
      const button = document.createElement('button');
      button.className = 'note-list-item';
      if (state.view === 'notes' && note.id === state.selectedId) button.classList.add('active');
      button.dataset.noteId = note.id;
      const title = document.createElement('strong');
      title.textContent = note.title || 'Untitled note';
      const meta = document.createElement('span');
      meta.textContent = `${note.category} · ${formatRelative(note.updatedAt)}`;
      button.append(title, meta);
      return button;
    }));
  }
}

async function setFilter(type, value = null) {
  state.filter = { type, value };
  await showLibrary();
  closeSidebar();
}

function notePreview(note) {
  const content = note.blocks
    .map((block) => block.content || block.name || '')
    .find((value) => String(value).trim());
  return String(content || 'No content yet').replace(/\s+/g, ' ').trim().slice(0, 110);
}

function renderLibrary() {
  const notes = filteredNotes();
  const title = state.search
    ? 'Search results'
    : state.filter.type === 'category'
      ? state.filter.value
      : state.filter.type === 'tag'
        ? `#${state.filter.value}`
        : 'All notes';
  $('#library-eyebrow').textContent = state.filter.type === 'category' ? 'CATEGORY' : (state.filter.type === 'tag' ? 'TAG' : 'LIBRARY');
  $('#library-title').textContent = title;
  $('#library-summary').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}${state.search ? ` matching “${state.search.trim()}”` : ''}.`;
  $('#library-table-wrap').classList.toggle('hidden', notes.length === 0);
  $('#library-empty').classList.toggle('hidden', notes.length !== 0);
  if (!notes.length) {
    $('#library-empty').innerHTML = `${icons.file}<p>${state.search ? 'No notes match this search.' : 'No notes in this view.'}</p>`;
    $('#library-table-body').replaceChildren();
    return;
  }

  $('#library-table-body').replaceChildren(...notes.map((note) => {
    const row = document.createElement('tr');
    const noteCell = document.createElement('td');
    const open = document.createElement('button');
    open.className = 'library-note-link';
    open.dataset.libraryNote = note.id;
    const noteTitle = document.createElement('strong');
    noteTitle.textContent = note.title || 'Untitled note';
    const preview = document.createElement('span');
    preview.textContent = notePreview(note);
    open.append(noteTitle, preview);
    noteCell.append(open);

    const categoryCell = document.createElement('td');
    const category = document.createElement('button');
    category.className = 'library-category';
    category.dataset.libraryCategory = note.category;
    category.innerHTML = icons.folder;
    category.append(document.createTextNode(note.category || 'Uncategorised'));
    categoryCell.append(category);

    const tagsCell = document.createElement('td');
    const tags = document.createElement('div');
    tags.className = 'library-tags';
    if (note.tags.length) {
      note.tags.forEach((tag) => {
        const button = document.createElement('button');
        button.dataset.libraryTag = tag;
        button.textContent = `#${tag}`;
        tags.append(button);
      });
    } else {
      const none = document.createElement('span');
      none.textContent = '—';
      tags.append(none);
    }
    tagsCell.append(tags);

    const updatedCell = document.createElement('td');
    const time = document.createElement('time');
    time.dateTime = note.updatedAt;
    time.title = new Date(note.updatedAt).toLocaleString();
    time.textContent = formatRelative(note.updatedAt);
    updatedCell.append(time);
    row.append(noteCell, categoryCell, tagsCell, updatedCell);
    return row;
  }));
}

async function showLibrary({ skipSave = false } = {}) {
  if (!skipSave && await saveNow() === false) return false;
  state.view = 'library';
  state.currentNote = null;
  state.selectedId = null;
  $('#note-editor').classList.add('hidden');
  $('#trash-view').classList.add('hidden');
  $('#empty-state').classList.add('hidden');
  $('#library-view').classList.remove('hidden');
  renderLibrary();
  renderSidebar();
  return true;
}

function showEmptyState(allowCreate = true) {
  state.currentNote = null;
  state.selectedId = null;
  $('#note-editor').classList.add('hidden');
  $('#trash-view').classList.add('hidden');
  $('#library-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  $('#empty-new-note').classList.toggle('hidden', !allowCreate);
}

async function selectNote(id, { skipSave = false } = {}) {
  if (!skipSave && state.currentNote?.id !== id && await saveNow() === false) return;
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  state.view = 'notes';
  state.selectedId = id;
  state.currentNote = clone(note);
  state.versionToken = uuid();
  state.versionTokenAt = Date.now();
  editGeneration = 0;
  savedGeneration = 0;
  $('#empty-state').classList.add('hidden');
  $('#trash-view').classList.add('hidden');
  $('#library-view').classList.add('hidden');
  $('#note-editor').classList.remove('hidden');
  renderEditor();
  renderSidebar();
  closeSidebar();
}

function renderEditor() {
  const note = state.currentNote;
  $('#note-title').value = note.title === 'Untitled note' ? '' : note.title;
  renderCategoryOptions();
  $('#note-category').value = note.category || '';
  $('#note-tags').value = note.tags.join(', ');
  renderBlocks();
  updateSaveStatus('saved');
  setEditorDisabled(state.offline);
}

function renderCategoryOptions() {
  const select = $('#note-category');
  const current = select.value;
  const options = state.categories.map((category) => {
    const option = document.createElement('option');
    option.value = category.name;
    option.textContent = category.name;
    return option;
  });
  select.replaceChildren(...options);
  select.value = state.categories.some((category) => category.name === current) ? current : (state.currentNote?.category || '');
}

function blockControl(role, title, icon, extra = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `block-control ${extra}`;
  button.dataset.role = role;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = icon;
  return button;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, textarea.classList.contains('code-content') ? 104 : 49)}px`;
}

function renderBlocks({ focusId = null } = {}) {
  const elements = state.currentNote.blocks.map((block, index) => {
    const card = document.createElement('article');
    card.className = `block-card ${block.type === 'code' ? 'code-block' : ''} ${block.type === 'image' ? 'image-block' : ''} ${block.type === 'file' ? 'attachment-block' : ''}`;
    card.dataset.blockId = block.id;
    card.draggable = !state.offline;

    const controls = document.createElement('div');
    controls.className = 'block-controls';
    controls.append(
      blockControl('move-up', 'Move block up', icons.up),
      blockControl('move-down', 'Move block down', icons.down),
      blockControl('drag', 'Drag to reorder', icons.grip, 'drag-handle'),
      blockControl('remove', 'Remove block', icons.trash, 'remove'),
    );

    if (block.type === 'text') {
      const input = document.createElement('textarea');
      input.className = 'block-content';
      input.dataset.role = 'content';
      input.placeholder = 'Write something…';
      input.value = block.content;
      card.append(input, controls);
      requestAnimationFrame(() => autoResize(input));
    }

    if (block.type === 'heading') {
      const input = document.createElement('input');
      input.className = 'heading-input';
      input.dataset.role = 'content';
      input.placeholder = 'Section heading';
      input.value = block.content;
      card.append(input, controls);
    }

    if (block.type === 'code') {
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.innerHTML = '<span class="code-dots"><i></i><i></i><i></i></span>';
      const language = document.createElement('select');
      language.className = 'language-input';
      language.dataset.role = 'language';
      const selectedLanguage = block.language || 'powershell';
      language.replaceChildren(...LANGUAGES.map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        return option;
      }));
      if (!LANGUAGES.some((item) => item.id === selectedLanguage)) {
        const option = document.createElement('option');
        option.value = selectedLanguage;
        option.textContent = selectedLanguage;
        language.append(option);
      }
      language.value = selectedLanguage;
      const copyButton = blockControl('copy', 'Copy code', icons.copy, 'copy-control');
      copyButton.append(document.createTextNode('Copy'));
      const downloadButton = blockControl('download-code', 'Download code', icons.download, 'download-control');
      controls.prepend(copyButton, downloadButton);
      toolbar.append(language, controls);
      const input = document.createElement('textarea');
      input.className = 'code-content';
      input.dataset.role = 'content';
      input.placeholder = '// Paste or write code here';
      input.spellcheck = false;
      input.value = block.content;
      card.append(toolbar, input);
      requestAnimationFrame(() => autoResize(input));
    }

    if (block.type === 'image') {
      if (block.content) {
        const image = document.createElement('img');
        image.src = block.content;
        image.alt = block.alt || '';
        card.append(image);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'image-placeholder';
        placeholder.innerHTML = `${icons.image}<span>No image selected</span>`;
        card.append(placeholder);
      }
      const alt = document.createElement('input');
      alt.className = 'image-alt';
      alt.dataset.role = 'alt';
      alt.placeholder = 'Add an image description…';
      alt.value = block.alt || '';
      card.append(alt, controls);
    }

    if (block.type === 'file') {
      const icon = document.createElement('div');
      icon.className = 'attachment-icon';
      icon.innerHTML = icons.attachment;
      const details = document.createElement('div');
      details.className = 'attachment-details';
      const name = document.createElement('strong');
      name.textContent = block.name;
      const meta = document.createElement('span');
      meta.textContent = `${formatBytes(block.size)}${block.mime ? ` · ${block.mime}` : ''}`;
      details.append(name, meta);
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'secondary-button attachment-download';
      download.dataset.role = 'download-file';
      download.innerHTML = `${icons.download}<span>Download</span>`;
      card.append(icon, details, download, controls);
    }

    card.dataset.index = index;
    return card;
  });
  $('#blocks').replaceChildren(...elements);
  setEditorDisabled(state.offline);
  if (focusId) {
    const target = $(`[data-block-id="${CSS.escape(focusId)}"] [data-role="content"]`);
    target?.focus();
  }
}

function updateSaveStatus(kind, message = '') {
  const element = $('#save-status');
  element.className = `save-status ${kind === 'saved' ? '' : kind}`;
  element.lastChild.textContent = message || ({ saved: 'Saved', saving: 'Saving…', error: 'Could not save', offline: 'Offline copy' }[kind]);
}

function markDirty() {
  if (state.offline || !state.currentNote) return;
  editGeneration += 1;
  updateSaveStatus('saving', 'Unsaved changes');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 750);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (state.offline || !state.currentNote || editGeneration === savedGeneration) return true;
  if (saveInFlight) return saveInFlight;

  if (Date.now() - state.versionTokenAt > 5 * 60 * 1000) {
    state.versionToken = uuid();
    state.versionTokenAt = Date.now();
  }

  const noteId = state.currentNote.id;
  const generation = editGeneration;
  const payload = { ...clone(state.currentNote), versionToken: state.versionToken };
  updateSaveStatus('saving');
  saveInFlight = (async () => {
    try {
      const saved = await api(`notes/${noteId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const index = state.notes.findIndex((note) => note.id === noteId);
      if (index >= 0) state.notes[index] = saved;
      savedGeneration = generation;
      if (state.selectedId === noteId && editGeneration === generation) state.currentNote = clone(saved);
      renderSidebar();
      await cacheSnapshot();
      if (editGeneration === savedGeneration) updateSaveStatus('saved');
      return true;
    } catch (error) {
      updateSaveStatus('error');
      toast(error.message, 'error');
      return false;
    } finally {
      saveInFlight = null;
    }
  })();
  const saveSucceeded = await saveInFlight;
  if (saveSucceeded && editGeneration !== savedGeneration && !state.offline) {
    saveTimer = setTimeout(saveNow, 150);
  }
  return saveSucceeded;
}

function newBlock(type, content = '') {
  const base = { id: uuid(), type, content };
  if (type === 'code') return { ...base, language: 'powershell' };
  if (type === 'heading') return { ...base, level: 2 };
  if (type === 'image') return { ...base, alt: '' };
  return base;
}

function showNewNoteDialog() {
  if (state.offline) return toast('New notes are unavailable while offline.', 'error');
  if (!state.categories.length) {
    renderCategoryManager();
    $('#categories-dialog').showModal();
    toast('Create a category before adding your first note.');
    setTimeout(() => $('#category-name').focus(), 0);
    return;
  }
  const preferred = state.filter.type === 'category' ? state.filter.value : state.currentNote?.category;
  const selected = state.categories.some((category) => category.name === preferred)
    ? preferred
    : state.categories[0].name;
  const list = $('#new-note-categories');
  list.replaceChildren(...state.categories.map((category) => {
    const label = document.createElement('label');
    label.className = 'category-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'new-note-category';
    checkbox.value = category.name;
    checkbox.checked = category.name === selected;
    const text = document.createElement('span');
    text.textContent = category.name;
    label.append(checkbox, text);
    return label;
  }));
  $('#new-note-dialog').showModal();
  setTimeout(() => $('input:checked', list)?.focus(), 0);
}

async function createNote(category) {
  if (state.offline) return toast('New notes are unavailable while offline.', 'error');
  if (await saveNow() === false) return false;
  try {
    const note = await api('notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled note', category, tags: [], blocks: [] }),
    });
    state.notes.unshift(note);
    state.filter = { type: 'all', value: null };
    state.search = '';
    $('#search').value = '';
    await cacheSnapshot();
    selectNote(note.id, { skipSave: true });
    setTimeout(() => $('#note-title').focus(), 0);
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

function addBlock(type) {
  if (!state.currentNote || state.offline) return;
  if (type === 'image') return $('#image-picker').click();
  if (type === 'file') return $('#file-picker').click();
  const block = newBlock(type);
  state.currentNote.blocks.push(block);
  renderBlocks({ focusId: block.id });
  markDirty();
}

function moveBlock(id, direction) {
  const blocks = state.currentNote.blocks;
  const index = blocks.findIndex((block) => block.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= blocks.length) return;
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  renderBlocks();
  markDirty();
}

async function fileToDataUrl(file) {
  if (file.type === 'image/gif') {
    if (file.size > 8 * 1024 * 1024) throw new Error('GIF images must be smaller than 8 MB.');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  const bitmap = await createImageBitmap(file);
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/webp', .86);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadAttachment(file) {
  return api('attachments', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
}

function safeFilename(value, fallback = 'download') {
  return String(value || fallback).trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || fallback;
}

function triggerDownload(url, filename) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function downloadCode(block) {
  const selected = String(block.language || 'powershell').toLocaleLowerCase();
  const language = LANGUAGES.find((item) => item.id === selected) || LANGUAGES.at(-1);
  const filename = `${safeFilename(state.currentNote.title, 'lambda-note')}.${language.extension}`;
  const objectUrl = URL.createObjectURL(new Blob([block.content], { type: 'text/plain;charset=utf-8' }));
  triggerDownload(objectUrl, filename);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function downloadAttachment(block) {
  const url = apiUrl(`attachments/${block.attachmentId}`);
  url.searchParams.set('name', block.name);
  triggerDownload(url, block.name);
}

async function showTrash() {
  if (await saveNow() === false) return;
  state.view = 'trash';
  state.currentNote = null;
  state.selectedId = null;
  $('#note-editor').classList.add('hidden');
  $('#empty-state').classList.add('hidden');
  $('#library-view').classList.add('hidden');
  $('#trash-view').classList.remove('hidden');
  renderTrash();
  renderSidebar();
  closeSidebar();
}

function renderTrash() {
  const container = $('#trash-list');
  if (!state.trash.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-list';
    empty.innerHTML = `${icons.trash}<p>The recycle bin is empty.</p>`;
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...state.trash.map((note) => {
    const card = document.createElement('article');
    card.className = 'trash-card';
    const icon = document.createElement('div');
    icon.className = 'trash-card-icon';
    icon.innerHTML = icons.file;
    const text = document.createElement('div');
    text.className = 'trash-card-text';
    const title = document.createElement('h3');
    title.textContent = note.title;
    const meta = document.createElement('p');
    meta.textContent = `Deleted ${formatRelative(note.deletedAt)}${note.category ? ` · ${note.category}` : ''}`;
    text.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'trash-card-actions';
    const restore = document.createElement('button');
    restore.className = 'secondary-button';
    restore.dataset.restoreNote = note.id;
    restore.innerHTML = `${icons.restore} Restore`;
    const remove = document.createElement('button');
    remove.className = 'icon-button danger-hover';
    remove.dataset.permanentNote = note.id;
    remove.title = 'Delete permanently';
    remove.innerHTML = icons.trash;
    actions.append(restore, remove);
    card.append(icon, text, actions);
    return card;
  }));
  $$('#trash-list button').forEach((button) => { button.disabled = state.offline; });
}

async function deleteCurrentNote() {
  if (!state.currentNote || state.offline) return;
  const accepted = await confirmAction(
    'Move this note to the recycle bin?',
    'You can restore it later from the recycle bin.',
    'Move to bin',
  );
  if (!accepted) return;
  if (await saveNow() === false) return;
  const id = state.currentNote.id;
  try {
    await api(`notes/${id}`, { method: 'DELETE' });
    const note = state.notes.find((item) => item.id === id);
    state.notes = state.notes.filter((item) => item.id !== id);
    state.trash.unshift({ ...note, deletedAt: new Date().toISOString() });
    await cacheSnapshot();
    renderSidebar();
    if (state.notes.length) selectNote(state.notes[0].id, { skipSave: true });
    else showEmptyState();
    toast('Note moved to the recycle bin.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function restoreNote(id) {
  if (state.offline) return;
  try {
    const note = await api(`notes/${id}/restore`, { method: 'POST' });
    state.trash = state.trash.filter((item) => item.id !== id);
    state.notes.unshift(note);
    await cacheSnapshot();
    renderTrash();
    renderSidebar();
    toast('Note restored.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function permanentlyDeleteNote(id) {
  if (state.offline) return;
  const accepted = await confirmAction(
    'Delete this note permanently?',
    'This removes the note and all of its saved versions. This cannot be undone.',
    'Delete forever',
  );
  if (!accepted) return;
  try {
    await api(`notes/${id}/permanent`, { method: 'DELETE' });
    state.trash = state.trash.filter((item) => item.id !== id);
    await cacheSnapshot();
    renderTrash();
    renderSidebar();
    toast('Note permanently deleted.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function showVersions() {
  if (!state.currentNote || state.offline) return;
  if (await saveNow() === false) return;
  const container = $('#versions-list');
  container.innerHTML = '<div class="empty-list"><p>Loading versions…</p></div>';
  $('#versions-dialog').showModal();
  try {
    const versions = await api(`notes/${state.currentNote.id}/versions`);
    if (!versions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      empty.textContent = 'No earlier versions yet. A snapshot is made when an editing session begins.';
      container.replaceChildren(empty);
      return;
    }
    container.replaceChildren(...versions.map((version) => {
      const item = document.createElement('div');
      item.className = 'version-item';
      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = version.title;
      const meta = document.createElement('span');
      const blockCount = version.blocks.length;
      meta.textContent = `${new Date(version.createdAt).toLocaleString()} · ${blockCount} block${blockCount === 1 ? '' : 's'}`;
      text.append(title, meta);
      const restore = document.createElement('button');
      restore.className = 'secondary-button';
      restore.dataset.restoreVersion = version.id;
      restore.textContent = 'Restore';
      item.append(text, restore);
      return item;
    }));
  } catch (error) {
    container.textContent = error.message;
  }
}

async function restoreVersion(versionId) {
  const accepted = await confirmAction('Restore this version?', 'Your current note will be kept in history before the earlier version is restored.', 'Restore');
  if (!accepted) return;
  try {
    const note = await api(`notes/${state.currentNote.id}/versions/${versionId}/restore`, { method: 'POST' });
    const index = state.notes.findIndex((item) => item.id === note.id);
    state.notes[index] = note;
    state.currentNote = clone(note);
    state.versionToken = uuid();
    state.versionTokenAt = Date.now();
    editGeneration = 0;
    savedGeneration = 0;
    $('#versions-dialog').close();
    renderEditor();
    renderSidebar();
    await cacheSnapshot();
    toast('Earlier version restored.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderCategoryManager() {
  const container = $('#category-manager-list');
  if (!state.categories.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-list';
    empty.textContent = 'No categories yet.';
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...state.categories.map((category) => {
    const item = document.createElement('div');
    item.className = 'category-manager-item';
    const name = document.createElement('strong');
    name.textContent = category.name;
    const count = document.createElement('span');
    const actualCount = state.notes.filter((note) => note.category === category.name).length;
    count.textContent = `${actualCount} note${actualCount === 1 ? '' : 's'}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button danger-hover';
    remove.dataset.deleteCategory = category.id;
    remove.title = 'Delete category';
    remove.setAttribute('aria-label', `Delete ${category.name}`);
    remove.innerHTML = icons.trash;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'icon-button';
    rename.dataset.renameCategory = category.id;
    rename.title = 'Rename category';
    rename.setAttribute('aria-label', `Rename ${category.name}`);
    rename.innerHTML = '<svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7l3 3"/></svg>';
    item.append(name, count, rename, remove);
    return item;
  }));
}

function showCategoryRename(id) {
  const category = state.categories.find((item) => item.id === id);
  const item = $(`[data-rename-category="${id}"]`)?.closest('.category-manager-item');
  if (!category || !item) return;
  const form = document.createElement('form');
  form.className = 'category-rename-form';
  form.dataset.renameCategoryForm = id;
  const input = document.createElement('input');
  input.value = category.name;
  input.maxLength = 80;
  input.required = true;
  input.setAttribute('aria-label', 'Category name');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary-button';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary-button';
  cancel.dataset.cancelCategoryRename = '';
  cancel.textContent = 'Cancel';
  form.append(input, save, cancel);
  item.replaceChildren(form);
  input.focus();
  input.select();
}

async function renameCategory(id, name) {
  const category = state.categories.find((item) => item.id === id);
  const cleaned = name.trim();
  if (!category || !cleaned) return;
  if (cleaned === category.name) return renderCategoryManager();
  if (await saveNow() === false) return;
  try {
    const renamed = await api(`categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: cleaned }),
    });
    const oldName = category.name;
    category.name = renamed.name;
    state.categories.sort((a, b) => a.name.localeCompare(b.name));
    [state.notes, state.trash].forEach((notes) => notes.forEach((note) => {
      if (note.category === oldName) note.category = renamed.name;
    }));
    if (state.currentNote?.category === oldName) state.currentNote.category = renamed.name;
    if (state.filter.type === 'category' && state.filter.value === oldName) state.filter.value = renamed.name;
    renderCategoryManager();
    renderCategoryOptions();
    renderSidebar();
    if (state.view === 'library') renderLibrary();
    if (state.view === 'trash') renderTrash();
    await cacheSnapshot();
    toast('Category renamed.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function addCategory(name) {
  try {
    const category = await api('categories', { method: 'POST', body: JSON.stringify({ name }) });
    if (!state.categories.some((item) => item.id === category.id)) state.categories.push({ ...category, noteCount: 0 });
    state.categories.sort((a, b) => a.name.localeCompare(b.name));
    renderCategoryManager();
    renderCategoryOptions();
    renderSidebar();
    $('#category-name').value = '';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteCategory(id) {
  const category = state.categories.find((item) => item.id === id);
  if (!category) return;
  const accepted = await confirmAction(
    `Delete “${category.name}”?`,
    'Only empty categories can be deleted. Categories still used by active or deleted notes are kept.',
    'Delete category',
  );
  if (!accepted) return;
  try {
    await api(`categories/${id}`, { method: 'DELETE' });
    state.categories = state.categories.filter((item) => item.id !== id);
    if (state.filter.type === 'category' && state.filter.value === category.name) state.filter = { type: 'all', value: null };
    renderCategoryManager();
    renderCategoryOptions();
    renderSidebar();
    await cacheSnapshot();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function confirmAction(title, message, actionLabel) {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-accept').textContent = actionLabel;
  $('#confirm-dialog').showModal();
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function settleConfirm(value) {
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
  confirmResolver?.(value);
  confirmResolver = null;
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 3600);
}

function openSidebar() {
  $('#sidebar').classList.add('open');
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  document.body.classList.remove('sidebar-open');
}

async function reconnect() {
  try {
    const status = await api('auth/status');
    if (!status.authenticated) return showLogin('Unlock Lambda to reconnect.');
    state.offline = false;
    updateConnectionUi();
    if (state.currentNote && editGeneration !== savedGeneration) {
      await saveNow();
      if (editGeneration !== savedGeneration) throw new Error('Pending changes could not be synced.');
    }
    const selected = state.selectedId;
    const snapshot = await api('bootstrap');
    applySnapshot(snapshot);
    state.selectedId = selected;
    await cacheSnapshot(snapshot);
    updateConnectionUi();
    showApp();
    toast('Back online and up to date.');
  } catch {
    state.offline = true;
    updateConnectionUi();
  }
}

function wireEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    $('#login-error').textContent = '';
    try {
      await api('auth/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
      $('#password').value = '';
      const snapshot = await api('bootstrap');
      applySnapshot(snapshot);
      state.offline = false;
      await cacheSnapshot(snapshot);
      showApp();
    } catch (error) {
      $('#login-error').textContent = error.message;
      $('#password').select();
    } finally {
      button.disabled = false;
    }
  });

  $('#toggle-password').addEventListener('click', () => {
    const input = $('#password');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggle-password').setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
  });

  ['#new-note', '#mobile-new-note', '#empty-new-note'].forEach((selector) => $(selector).addEventListener('click', showNewNoteDialog));
  $('#delete-note').addEventListener('click', deleteCurrentNote);
  $('#versions-button').addEventListener('click', showVersions);
  $('#trash-nav').addEventListener('click', showTrash);
  $('#settings-nav').addEventListener('click', () => {
    closeSidebar();
    $('#settings-dialog').showModal();
  });
  $('#settings-categories').addEventListener('click', () => {
    $('#settings-dialog').close();
    renderCategoryManager();
    $('#categories-dialog').showModal();
    setTimeout(() => $('#category-name').focus(), 0);
  });
  $('#export-backup').addEventListener('click', downloadBackup);
  $('#import-backup').addEventListener('click', () => $('#backup-picker').click());
  $('#backup-picker').addEventListener('change', (event) => {
    const [file] = event.target.files;
    if (file) importBackup(file);
  });
  $('#open-sidebar').addEventListener('click', openSidebar);
  $('#close-sidebar').addEventListener('click', closeSidebar);
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);

  $('.filter-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (button) setFilter(button.dataset.filter);
  });
  $('#categories-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (button) setFilter('category', button.dataset.category);
  });
  $('#tag-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag]');
    if (button) setFilter('tag', button.dataset.tag);
  });
  $('#note-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-note-id]');
    if (button) selectNote(button.dataset.noteId);
  });

  $('#library-view').addEventListener('click', (event) => {
    const note = event.target.closest('[data-library-note]');
    const category = event.target.closest('[data-library-category]');
    const tag = event.target.closest('[data-library-tag]');
    if (note) selectNote(note.dataset.libraryNote);
    else if (category) setFilter('category', category.dataset.libraryCategory);
    else if (tag) setFilter('tag', tag.dataset.libraryTag);
  });

  $('#search').addEventListener('input', async (event) => {
    state.search = event.target.value;
    if (state.search) state.filter = { type: 'all', value: null };
    await showLibrary();
  });

  $('#note-title').addEventListener('input', (event) => {
    state.currentNote.title = event.target.value || 'Untitled note';
    markDirty();
  });
  $('#note-category').addEventListener('change', (event) => {
    state.currentNote.category = event.target.value;
    markDirty();
  });
  $('#note-tags').addEventListener('input', (event) => {
    const seen = new Set();
    state.currentNote.tags = event.target.value.split(',').map((tag) => tag.trim()).filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);
    markDirty();
  });

  $('#blocks').addEventListener('input', (event) => {
    const card = event.target.closest('[data-block-id]');
    if (!card) return;
    const block = state.currentNote.blocks.find((item) => item.id === card.dataset.blockId);
    if (!block) return;
    const role = event.target.dataset.role;
    if (['content', 'language', 'alt'].includes(role)) block[role] = event.target.value;
    if (event.target.matches('textarea')) autoResize(event.target);
    markDirty();
  });

  $('#blocks').addEventListener('keydown', (event) => {
    if (event.target.classList.contains('code-content') && event.key === 'Tab') {
      event.preventDefault();
      const input = event.target;
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  $('#blocks').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-role]');
    const card = event.target.closest('[data-block-id]');
    if (!button || !card || state.offline) return;
    const id = card.dataset.blockId;
    if (button.dataset.role === 'move-up') moveBlock(id, -1);
    if (button.dataset.role === 'move-down') moveBlock(id, 1);
    if (button.dataset.role === 'remove') {
      state.currentNote.blocks = state.currentNote.blocks.filter((block) => block.id !== id);
      renderBlocks();
      markDirty();
    }
    if (button.dataset.role === 'copy') {
      const block = state.currentNote.blocks.find((item) => item.id === id);
      try {
        await navigator.clipboard.writeText(block.content);
        button.lastChild.textContent = 'Copied';
        setTimeout(() => { if (button.isConnected) button.lastChild.textContent = 'Copy'; }, 1300);
      } catch {
        toast('Could not access the clipboard.', 'error');
      }
    }
    if (button.dataset.role === 'download-code') {
      const block = state.currentNote.blocks.find((item) => item.id === id);
      if (block) downloadCode(block);
    }
    if (button.dataset.role === 'download-file') {
      const block = state.currentNote.blocks.find((item) => item.id === id);
      if (block) downloadAttachment(block);
    }
  });

  $('#blocks').addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-block-id]');
    if (!card || state.offline) return;
    draggedBlockId = card.dataset.blockId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  $('#blocks').addEventListener('dragover', (event) => {
    const card = event.target.closest('[data-block-id]');
    if (!card || card.dataset.blockId === draggedBlockId) return;
    event.preventDefault();
    $$('.drag-over', $('#blocks')).forEach((item) => item.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  $('#blocks').addEventListener('drop', (event) => {
    const target = event.target.closest('[data-block-id]');
    if (!target || !draggedBlockId) return;
    event.preventDefault();
    const blocks = state.currentNote.blocks;
    const from = blocks.findIndex((block) => block.id === draggedBlockId);
    const to = blocks.findIndex((block) => block.id === target.dataset.blockId);
    const [moved] = blocks.splice(from, 1);
    blocks.splice(to, 0, moved);
    draggedBlockId = null;
    renderBlocks();
    markDirty();
  });
  $('#blocks').addEventListener('dragend', () => {
    draggedBlockId = null;
    $$('.dragging, .drag-over', $('#blocks')).forEach((item) => item.classList.remove('dragging', 'drag-over'));
  });

  $('#block-adder').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add-block]');
    if (button) addBlock(button.dataset.addBlock);
  });
  $('#image-picker').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file || !state.currentNote) return;
    try {
      const block = newBlock('image', await fileToDataUrl(file));
      block.alt = file.name.replace(/\.[^.]+$/, '');
      state.currentNote.blocks.push(block);
      renderBlocks();
      markDirty();
    } catch (error) {
      toast(error.message || 'That image could not be added.', 'error');
    }
  });
  $('#file-picker').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (!file || !state.currentNote) return;
    try {
      const uploaded = await uploadAttachment(file);
      state.currentNote.blocks.push({
        id: uuid(),
        type: 'file',
        attachmentId: uploaded.id,
        name: uploaded.name,
        size: uploaded.size,
        mime: uploaded.mime,
      });
      renderBlocks();
      markDirty();
    } catch (error) {
      toast(error.message || 'That file could not be attached.', 'error');
    }
  });

  $('#trash-list').addEventListener('click', (event) => {
    const restore = event.target.closest('[data-restore-note]');
    const permanent = event.target.closest('[data-permanent-note]');
    if (restore) restoreNote(restore.dataset.restoreNote);
    if (permanent) permanentlyDeleteNote(permanent.dataset.permanentNote);
  });
  $('#versions-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-restore-version]');
    if (button) restoreVersion(Number(button.dataset.restoreVersion));
  });

  $('#manage-categories').addEventListener('click', () => {
    renderCategoryManager();
    $('#categories-dialog').showModal();
    setTimeout(() => $('#category-name').focus(), 0);
  });
  $('#category-form').addEventListener('submit', (event) => {
    event.preventDefault();
    addCategory($('#category-name').value);
  });
  $('#new-note-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    const category = $('input[name="new-note-category"]:checked', event.currentTarget)?.value;
    if (!category) {
      button.disabled = false;
      return toast('Choose a category.', 'error');
    }
    try {
      if (await createNote(category)) $('#new-note-dialog').close();
    } finally {
      button.disabled = false;
    }
  });
  $('#category-manager-list').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-delete-category]');
    const rename = event.target.closest('[data-rename-category]');
    const cancel = event.target.closest('[data-cancel-category-rename]');
    if (remove) deleteCategory(Number(remove.dataset.deleteCategory));
    else if (rename) showCategoryRename(Number(rename.dataset.renameCategory));
    else if (cancel) renderCategoryManager();
  });
  $('#category-manager-list').addEventListener('submit', (event) => {
    const form = event.target.closest('[data-rename-category-form]');
    if (!form) return;
    event.preventDefault();
    renameCategory(Number(form.dataset.renameCategoryForm), $('input', form).value);
  });
  $('#new-note-categories').addEventListener('change', (event) => {
    if (!event.target.checked) {
      event.target.checked = true;
      return;
    }
    $$('input[type="checkbox"]', event.currentTarget).forEach((checkbox) => {
      if (checkbox !== event.target) checkbox.checked = false;
    });
  });

  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('#confirm-accept').addEventListener('click', () => settleConfirm(true));
  $('#confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing && !$('#app-shell').classList.contains('hidden')) {
      event.preventDefault();
      $('#search').focus();
    }
    if (event.key.toLocaleLowerCase() === 'n' && !typing && !event.ctrlKey && !event.metaKey && !state.offline && !$('#app-shell').classList.contains('hidden')) {
      event.preventDefault();
      showNewNoteDialog();
    }
  });

  window.addEventListener('offline', () => {
    state.offline = true;
    clearTimeout(saveTimer);
    updateConnectionUi();
  });
  window.addEventListener('online', reconnect);
  window.addEventListener('beforeunload', () => { if (editGeneration !== savedGeneration) saveNow(); });
}

boot();
