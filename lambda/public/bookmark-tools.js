const APP_BASE = new URL('.', import.meta.url);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = { bookmarks: [], showing: false, tag: '', loading: false };

function apiUrl(path = '') { return new URL(`api/${path.replace(/^\//, '')}`, APP_BASE); }

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

function closeSidebar() {
  $('#sidebar')?.classList.remove('open');
  document.body.classList.remove('sidebar-open');
}

function parseTags(value) {
  const seen = new Set();
  return String(value || '').split(',').map((tag) => tag.trim()).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function relativeTime(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  for (const [unit, amount] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= amount) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / amount), unit);
  }
  return 'just now';
}

function ensureUi() {
  const filterNav = $('.filter-nav');
  const workspace = $('.workspace');
  const offlineBanner = $('#offline-banner');
  if (!filterNav || !workspace || !offlineBanner) return false;
  if (!$('#bookmarks-nav')) {
    const nav = document.createElement('div');
    nav.className = 'nav-item-row';
    nav.innerHTML = '<button id="bookmarks-nav" type="button" class="nav-item"><span><svg viewBox="0 0 24 24"><path d="M6 4.5h12v16l-6-4-6 4z"/></svg>Bookmarks</span><span id="bookmarks-count" class="count">0</span></button><button id="bookmarks-create" class="nav-create-button" type="button" aria-label="Create new bookmark" title="Create new bookmark"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>';
    const todos = $('#todos-nav')?.closest('.nav-item-row');
    todos ? todos.insertAdjacentElement('afterend', nav) : filterNav.prepend(nav);
  }
  if (!$('#bookmarks-view')) {
    const view = document.createElement('section');
    view.id = 'bookmarks-view';
    view.className = 'bookmarks-view hidden';
    view.innerHTML = `
      <header class="page-header bookmarks-header">
        <p class="eyebrow">SAVED LINKS</p>
        <h1>Bookmarks</h1>
      </header>
      <form id="bookmark-create-form" class="bookmark-create-form">
        <label><span>URL</span><input id="bookmark-url" type="url" maxlength="2000" placeholder="https://example.com/article" autocomplete="url" required></label>
        <label><span>Tags <em>optional</em></span><input id="bookmark-tags" maxlength="500" placeholder="research, design" autocomplete="off"></label>
        <button class="primary-button" type="submit">Add bookmark</button>
        <p>We’ll fetch the page title; you can edit it afterwards.</p>
      </form>
      <section class="bookmark-section" aria-labelledby="bookmarks-heading">
        <div class="bookmark-section-heading"><div></div><span id="bookmarks-summary"></span></div>
        <div id="bookmarks-list" class="bookmark-list"></div>
      </section>`;
    offlineBanner.insertAdjacentElement('afterend', view);
  }
  if (!$('#tag-results-view')) {
    const view = document.createElement('section');
    view.id = 'tag-results-view';
    view.className = 'bookmarks-view tag-results-view hidden';
    view.innerHTML = '<header class="page-header bookmarks-header"><p class="eyebrow">TAG</p><h1 id="tag-results-title"></h1><p id="tag-results-summary"></p></header><section class="bookmark-section"><h2>Notes</h2><div id="tag-notes-list" class="tag-note-list"></div></section><section class="bookmark-section"><h2>Bookmarks</h2><div id="tag-bookmarks-list" class="bookmark-list"></div></section>';
    offlineBanner.insertAdjacentElement('afterend', view);
  }
  return true;
}

function otherViews() { return ['#empty-state', '#library-view', '#note-editor', '#trash-view', '#todos-view', '#tag-results-view', '#search-results-view'].map((selector) => $(selector)).filter(Boolean); }

function bookmarkCard(bookmark, { compact = false } = {}) {
  const card = document.createElement('article');
  card.className = `bookmark-card${compact ? ' compact' : ''}`;
  card.dataset.bookmarkId = bookmark.id;
  const title = document.createElement('input');
  title.className = 'bookmark-title-input';
  title.value = bookmark.title;
  title.maxLength = 300;
  title.dataset.bookmarkTitle = '';
  title.setAttribute('aria-label', 'Bookmark title');
  const link = document.createElement('a');
  link.className = 'bookmark-url';
  link.href = bookmark.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = bookmark.url;
  const tags = document.createElement('div');
  tags.className = 'bookmark-tags';
  for (const tag of bookmark.tags) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.bookmarkTag = tag; button.textContent = `#${tag}`; tags.append(button);
  }
  const tagInput = document.createElement('input');
  tagInput.className = 'bookmark-tags-input';
  tagInput.dataset.bookmarkTags = '';
  tagInput.value = bookmark.tags.join(', ');
  tagInput.maxLength = 500;
  tagInput.placeholder = 'Add tags, separated by commas';
  tagInput.setAttribute('aria-label', 'Bookmark tags');
  const updated = document.createElement('time');
  updated.className = 'bookmark-updated'; updated.dateTime = bookmark.updatedAt; updated.title = new Date(bookmark.updatedAt).toLocaleString(); updated.textContent = `Saved ${relativeTime(bookmark.updatedAt)}`;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'icon-button danger-hover bookmark-delete'; remove.dataset.deleteBookmark = ''; remove.title = 'Delete bookmark'; remove.setAttribute('aria-label', 'Delete bookmark');
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>';
  const footer = document.createElement('div'); footer.className = 'bookmark-footer'; footer.append(updated, remove);
  card.append(title, link, tags, tagInput, footer);
  return card;
}

function renderBookmarks() {
  $('#bookmarks-count').textContent = state.bookmarks.length;
  $('#bookmarks-summary').textContent = `${state.bookmarks.length} saved`;
  const list = $('#bookmarks-list');
  if (!state.bookmarks.length) { list.innerHTML = '<div class="bookmark-empty"><strong>No bookmarks yet</strong><span>Add a URL above and Lambda will save its page title.</span></div>'; return; }
  list.replaceChildren(...state.bookmarks.map((bookmark) => bookmarkCard(bookmark)));
}

async function refreshBookmarks({ silent = false } = {}) {
  try { state.bookmarks = await api('bookmarks'); renderBookmarks(); syncTagSidebar(); }
  catch (error) { if (!silent && state.showing) $('#bookmarks-list').innerHTML = `<div class="bookmark-empty error">${error.message}</div>`; }
}

async function showBookmarks() {
  if (!ensureUi()) return;
  otherViews().forEach((view) => view.classList.add('hidden'));
  $('#bookmarks-view').classList.remove('hidden');
  $('#bookmarks-nav').classList.add('active');
  $('.filter-nav [data-filter="all"]')?.classList.remove('active');
  $('#todos-nav')?.classList.remove('active');
  state.showing = true; state.tag = '';
  closeSidebar();
  await refreshBookmarks();
}

function hideBookmarkViews() {
  $('#bookmarks-view')?.classList.add('hidden');
  $('#tag-results-view')?.classList.add('hidden');
  $('#bookmarks-nav')?.classList.remove('active');
  state.showing = false;
}

function notePreview(note) {
  return (note.blocks || []).map((block) => block.content || block.name || '').find((item) => String(item).trim())?.replace(/\s+/g, ' ').trim().slice(0, 160) || 'No content yet';
}

function noteCard(note) {
  const card = document.createElement('article'); card.className = 'tag-note-card';
  const title = document.createElement('strong'); title.textContent = note.title || 'Untitled note';
  const preview = document.createElement('p'); preview.textContent = notePreview(note);
  card.append(title, preview); return card;
}

async function showTagResults(tag) {
  if (!ensureUi()) return;
  otherViews().forEach((view) => view.classList.add('hidden'));
  $('#tag-results-view').classList.remove('hidden');
  $('#tag-results-title').textContent = `#${tag}`;
  $('#tag-results-summary').textContent = 'Loading notes and bookmarks…';
  $('#bookmarks-nav').classList.remove('active');
  state.showing = false; state.tag = tag;
  closeSidebar();
  try {
    const [notes, bookmarks] = await Promise.all([api(`notes?tag=${encodeURIComponent(tag)}`), api(`bookmarks?tag=${encodeURIComponent(tag)}`)]);
    $('#tag-results-summary').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'} and ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}.`;
    $('#tag-notes-list').replaceChildren(...(notes.length ? notes.map(noteCard) : [empty('No notes use this tag yet.')]));
    $('#tag-bookmarks-list').replaceChildren(...(bookmarks.length ? bookmarks.map((bookmark) => bookmarkCard(bookmark, { compact: true })) : [empty('No bookmarks use this tag yet.')]));
  } catch (error) { $('#tag-results-summary').textContent = error.message || 'Tag results could not be loaded.'; }
}

function empty(message) { const el = document.createElement('div'); el.className = 'bookmark-empty'; el.textContent = message; return el; }

function syncTagSidebar() {
  const tagList = $('#tag-list');
  if (!tagList) return;
  const bookmarkCounts = new Map();
  state.bookmarks.forEach((bookmark) => bookmark.tags.forEach((tag) => {
    const key = tag.toLocaleLowerCase(); const item = bookmarkCounts.get(key) || { tag, count: 0 }; item.count += 1; bookmarkCounts.set(key, item);
  }));
  const existing = new Map($$('[data-tag]', tagList).map((button) => [button.dataset.tag.toLocaleLowerCase(), button]));
  for (const [key, { tag, count }] of bookmarkCounts) {
    const button = existing.get(key);
    if (button) {
      const noteCount = Number(button.dataset.noteCount || button.textContent.match(/·\s*(\d+)$/)?.[1] || 0);
      button.dataset.noteCount = String(noteCount);
      const label = `#${button.dataset.tag} · ${noteCount + count}`;
      if (button.textContent !== label) button.textContent = label;
    } else {
      const added = document.createElement('button'); added.className = 'sidebar-tag'; added.dataset.tag = tag; added.dataset.noteCount = '0'; added.dataset.bookmarkOnly = 'true'; added.textContent = `#${tag} · ${count}`; tagList.append(added);
    }
  }
  $('#tag-section')?.classList.toggle('hidden', !tagList.children.length);
}

async function createBookmark(event) {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true; button.textContent = 'Fetching title…';
  try {
    const created = await api('bookmarks', { method: 'POST', body: JSON.stringify({ url: $('#bookmark-url').value.trim(), tags: parseTags($('#bookmark-tags').value) }) });
    state.bookmarks.unshift(created); $('#bookmark-url').value = ''; $('#bookmark-tags').value = ''; renderBookmarks(); syncTagSidebar(); $('#bookmark-url').focus();
  } catch (error) { window.alert(error.message || 'Bookmark could not be added.'); }
  finally { button.disabled = false; button.textContent = 'Add bookmark'; }
}

async function patchBookmark(card, changes) {
  const id = card.dataset.bookmarkId; const updated = await api(`bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });
  const index = state.bookmarks.findIndex((item) => item.id === id); if (index >= 0) state.bookmarks[index] = updated;
  renderBookmarks(); syncTagSidebar(); return updated;
}

function wireEvents() {
  window.addEventListener('lambda:open-bookmark', async (event) => {
    const id = event.detail?.id;
    if (!id) return;
    await showBookmarks();
    requestAnimationFrame(() => $(`[data-bookmark-id="${id}"] [data-bookmark-title]`)?.focus());
  });
  document.addEventListener('click', (event) => {
    const tag = event.target.closest('#tag-list [data-tag], [data-bookmark-tag]');
    if (tag) { event.preventDefault(); event.stopImmediatePropagation(); showTagResults(tag.dataset.tag || tag.dataset.bookmarkTag); }
  }, true);
  document.addEventListener('click', (event) => {
    if (event.target.closest('#bookmarks-nav')) showBookmarks();
    else if (event.target.closest('#sidebar-brand, #todos-nav, .filter-nav [data-filter], #categories-list, #note-list, #trash-nav, #notes-create, #mobile-new-note, #empty-new-note')) hideBookmarkViews();
  }, true);
  document.addEventListener('click', async (event) => {
    if (!event.target.closest('#bookmarks-create')) return;
    await showBookmarks();
    $('#bookmark-url').focus();
  });
  document.addEventListener('submit', (event) => { if (event.target.matches('#bookmark-create-form')) createBookmark(event); });
  document.addEventListener('change', async (event) => {
    const card = event.target.closest('[data-bookmark-id]'); if (!card) return;
    try {
      if (event.target.matches('[data-bookmark-title]')) { const title = event.target.value.trim(); if (title) await patchBookmark(card, { title }); }
      if (event.target.matches('[data-bookmark-tags]')) await patchBookmark(card, { tags: parseTags(event.target.value) });
    } catch (error) { window.alert(error.message || 'Bookmark could not be updated.'); await refreshBookmarks({ silent: true }); }
  });
  document.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-bookmark-id]'); if (!card || !event.target.closest('[data-delete-bookmark]')) return;
    if (!window.confirm('Move this bookmark to the recycle bin?')) return;
    try {
      await api(`bookmarks/${card.dataset.bookmarkId}`, { method: 'DELETE' });
      state.bookmarks = state.bookmarks.filter((item) => item.id !== card.dataset.bookmarkId);
      renderBookmarks();
      syncTagSidebar();
      window.dispatchEvent(new CustomEvent('lambda:trash-changed', { detail: { type: 'bookmark', id: card.dataset.bookmarkId } }));
    }
    catch (error) { window.alert(error.message || 'Bookmark could not be deleted.'); }
  });
  const tagList = $('#tag-list');
  if (tagList) new MutationObserver(() => queueMicrotask(syncTagSidebar)).observe(tagList, { childList: true });
}

function boot() {
  if (!ensureUi()) return setTimeout(boot, 25);
  wireEvents();
  refreshBookmarks({ silent: true });
}

boot();
