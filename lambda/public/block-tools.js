const APP_BASE = new URL('.', import.meta.url);
const blockMap = new Map();
let pendingCsv = false;
let refreshTimer = null;

function apiUrl(path) {
  return new URL(`api/${path.replace(/^\//, '')}`, APP_BASE);
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length || !rows.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  const width = Math.max(1, ...rows.map((item) => item.length));
  const normalized = rows.map((item) => [...item, ...Array(width - item.length).fill('')]);
  if (normalized.length === 1) normalized.push(Array(width).fill(''));
  return normalized;
}

function serializeCsv(rows) {
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n');
}

function safeFilename(value) {
  return String(value || 'lambda-table').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || 'lambda-table';
}

function downloadCsv(content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilename(document.querySelector('#note-title')?.value || 'lambda-table')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function offline() {
  return !document.querySelector('#offline-banner')?.classList.contains('hidden');
}

function updateCsvDisabledState(card) {
  const disabled = offline();
  card.querySelectorAll('.csv-cell-input, .csv-header-name, [data-csv-edit], .csv-generated-controls button').forEach((element) => {
    element.disabled = disabled;
  });
}

function syncSource(card, rows) {
  const source = card.querySelector('[data-csv-source]');
  if (!source) return;
  source.value = serializeCsv(rows);
  source.dispatchEvent(new Event('input', { bubbles: true }));
  const block = blockMap.get(card.dataset.blockId);
  if (block) block.content = source.value;
}

function normalizeTableState(state, rows) {
  const width = rows[0]?.length || 1;
  while (state.filters.length < width) state.filters.push('');
  state.filters.length = width;
  if (state.sortColumn !== null && state.sortColumn >= width) {
    state.sortColumn = null;
    state.sortDirection = 0;
  }
}

function compareValues(left, right) {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  const leftNumber = Number(leftText);
  const rightNumber = Number(rightText);
  if (leftText && rightText && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}

function visibleRows(rows, state) {
  const globalFilter = state.globalFilter.trim().toLocaleLowerCase();
  const filters = state.filters.map((value) => value.trim().toLocaleLowerCase());
  const values = rows.slice(1).map((row, index) => ({ row, sourceIndex: index + 1 }));
  const filtered = values.filter(({ row }) => {
    if (globalFilter && !row.some((value) => String(value ?? '').toLocaleLowerCase().includes(globalFilter))) return false;
    return filters.every((filter, columnIndex) => !filter || String(row[columnIndex] ?? '').toLocaleLowerCase().includes(filter));
  });
  if (state.sortColumn === null || !state.sortDirection) return filtered;
  return filtered.sort((left, right) => {
    const compared = compareValues(left.row[state.sortColumn], right.row[state.sortColumn]);
    return compared ? compared * state.sortDirection : left.sourceIndex - right.sourceIndex;
  });
}

function updateSortButtons(card, state) {
  card.querySelectorAll('[data-csv-sort]').forEach((button) => {
    const columnIndex = Number(button.dataset.csvSort);
    const active = state.sortColumn === columnIndex && state.sortDirection;
    button.textContent = active ? (state.sortDirection === 1 ? '↑' : '↓') : '↕';
    button.classList.toggle('active', Boolean(active));
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function renderTableBody(card, rows, state) {
  const body = card.querySelector('.csv-editor-table tbody');
  if (!body) return;
  const records = visibleRows(rows, state);
  if (!records.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'csv-no-results';
    cell.colSpan = rows[0]?.length || 1;
    cell.textContent = rows.length > 1 ? 'No rows match the current filters.' : 'No data rows yet.';
    row.append(cell);
    body.replaceChildren(row);
    return;
  }

  body.replaceChildren(...records.map(({ row, sourceIndex }) => {
    const tr = document.createElement('tr');
    tr.dataset.csvSourceRow = sourceIndex;
    row.forEach((value, columnIndex) => {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.className = 'csv-cell-input';
      input.value = value;
      input.disabled = offline();
      input.setAttribute('aria-label', `Data row ${sourceIndex}, column ${columnIndex + 1}`);
      input.addEventListener('input', (event) => {
        event.stopPropagation();
        rows[sourceIndex][columnIndex] = input.value;
        syncSource(card, rows);
      });
      cell.append(input);
      tr.append(cell);
    });
    return tr;
  }));
}

function renderTable(card, rows, state) {
  const holder = card.querySelector('[data-csv-table]');
  if (!holder) return;
  normalizeTableState(state, rows);

  const table = document.createElement('table');
  table.className = 'csv-editor-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');

  (rows[0] || ['']).forEach((value, columnIndex) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    const top = document.createElement('div');
    top.className = 'csv-header-main';

    const name = document.createElement('input');
    name.className = 'csv-header-name';
    name.value = value;
    name.disabled = offline();
    name.placeholder = `Column ${columnIndex + 1}`;
    name.setAttribute('aria-label', `Column ${columnIndex + 1} heading`);
    name.addEventListener('input', (event) => {
      event.stopPropagation();
      rows[0][columnIndex] = name.value;
      syncSource(card, rows);
    });

    const sort = document.createElement('button');
    sort.type = 'button';
    sort.className = 'csv-sort-button';
    sort.dataset.csvSort = columnIndex;
    sort.title = `Sort column ${columnIndex + 1}`;
    sort.setAttribute('aria-label', `Sort column ${columnIndex + 1}`);
    sort.addEventListener('click', () => {
      if (state.sortColumn !== columnIndex) {
        state.sortColumn = columnIndex;
        state.sortDirection = 1;
      } else if (state.sortDirection === 1) state.sortDirection = -1;
      else if (state.sortDirection === -1) {
        state.sortColumn = null;
        state.sortDirection = 0;
      } else state.sortDirection = 1;
      renderTableBody(card, rows, state);
      updateSortButtons(card, state);
    });

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'csv-column-filter';
    filter.placeholder = 'Filter…';
    filter.value = state.filters[columnIndex] || '';
    filter.setAttribute('aria-label', `Filter column ${columnIndex + 1}`);
    filter.addEventListener('input', (event) => {
      event.stopPropagation();
      state.filters[columnIndex] = filter.value;
      renderTableBody(card, rows, state);
    });

    top.append(name, sort);
    cell.append(top, filter);
    headerRow.append(cell);
  });

  head.append(headerRow);
  const body = document.createElement('tbody');
  table.append(head, body);
  holder.replaceChildren(table);
  renderTableBody(card, rows, state);
  updateSortButtons(card, state);
}

function editingButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button';
  button.dataset.csvEdit = '';
  button.textContent = label;
  button.disabled = offline();
  button.addEventListener('click', action);
  return button;
}

function actionButton(role, label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `block-control${role === 'remove' ? ' remove' : ''}`;
  button.dataset.role = role;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.textContent = label;
  return button;
}

function ensureBlockControls(card) {
  let controls = card.querySelector('.block-controls');
  if (controls) return controls;
  controls = document.createElement('div');
  controls.className = 'block-controls csv-generated-controls';
  const drag = actionButton('drag', '⠿', 'Drag to reorder');
  drag.classList.add('drag-handle');
  controls.append(
    actionButton('move-up', '↑', 'Move block up'),
    actionButton('move-down', '↓', 'Move block down'),
    drag,
    actionButton('remove', '×', 'Remove block'),
  );
  card.append(controls);
  return controls;
}

function enhanceCsv(card, block) {
  if (card.dataset.csvEnhanced === '1') {
    updateCsvDisabledState(card);
    return;
  }
  card.dataset.csvEnhanced = '1';
  card.classList.add('csv-block');
  const rows = parseCsv(block.content || '');
  const tableState = {
    sortColumn: null,
    sortDirection: 0,
    filters: Array(rows[0]?.length || 1).fill(''),
    globalFilter: '',
  };
  const controls = ensureBlockControls(card);

  const toolbar = document.createElement('div');
  toolbar.className = 'csv-toolbar';
  const label = document.createElement('strong');
  label.textContent = 'CSV table';

  const globalFilter = document.createElement('input');
  globalFilter.type = 'search';
  globalFilter.className = 'csv-global-filter';
  globalFilter.placeholder = 'Filter table…';
  globalFilter.setAttribute('aria-label', 'Filter all table rows');
  globalFilter.addEventListener('input', () => {
    tableState.globalFilter = globalFilter.value;
    renderTableBody(card, rows, tableState);
  });

  const clearFilters = document.createElement('button');
  clearFilters.type = 'button';
  clearFilters.className = 'secondary-button';
  clearFilters.textContent = 'Clear filters';
  clearFilters.addEventListener('click', () => {
    tableState.globalFilter = '';
    tableState.filters.fill('');
    globalFilter.value = '';
    card.querySelectorAll('.csv-column-filter').forEach((input) => { input.value = ''; });
    renderTableBody(card, rows, tableState);
  });

  const addRow = editingButton('Add row', () => {
    rows.push(Array(rows[0]?.length || 1).fill(''));
    renderTableBody(card, rows, tableState);
    syncSource(card, rows);
  });

  const addColumn = editingButton('Add column', () => {
    rows.forEach((row) => row.push(''));
    tableState.filters.push('');
    renderTable(card, rows, tableState);
    syncSource(card, rows);
  });

  const removeRow = editingButton('Remove row', () => {
    if (rows.length <= 2) return;
    rows.pop();
    renderTableBody(card, rows, tableState);
    syncSource(card, rows);
  });

  const removeColumn = editingButton('Remove column', () => {
    if ((rows[0]?.length || 1) <= 1) return;
    rows.forEach((row) => row.pop());
    normalizeTableState(tableState, rows);
    renderTable(card, rows, tableState);
    syncSource(card, rows);
  });

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-button';
  download.textContent = 'Download CSV';
  download.addEventListener('click', () => downloadCsv(serializeCsv(rows)));

  toolbar.append(label, globalFilter, clearFilters, addRow, addColumn, removeRow, removeColumn, download);

  const tableHolder = document.createElement('div');
  tableHolder.className = 'csv-table-wrap';
  tableHolder.dataset.csvTable = '';

  const source = document.createElement('textarea');
  source.className = 'hidden';
  source.dataset.csvSource = '';
  source.dataset.role = 'content';
  source.value = block.content || '';

  card.insertBefore(toolbar, controls);
  card.insertBefore(tableHolder, controls);
  card.insertBefore(source, controls);
  renderTable(card, rows, tableState);
  updateCsvDisabledState(card);
}

function addCodeBadge(card, block) {
  if (!block?.code || card.querySelector('[data-block-code]')) return;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'block-code';
  badge.dataset.blockCode = block.code;
  badge.title = 'Copy block code';
  badge.textContent = block.code;
  badge.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      const original = badge.textContent;
      badge.textContent = 'Copied';
      setTimeout(() => { if (badge.isConnected) badge.textContent = original; }, 900);
    } catch {}
  });
  card.prepend(badge);
}

function enhanceCards() {
  let missing = false;
  document.querySelectorAll('#blocks [data-block-id]').forEach((card) => {
    card.draggable = false;
    let block = blockMap.get(card.dataset.blockId);
    if (!block && pendingCsv) {
      block = { id: card.dataset.blockId, type: 'csv', content: '' };
      blockMap.set(block.id, block);
      pendingCsv = false;
    }
    if (!block) {
      missing = true;
      return;
    }
    addCodeBadge(card, block);
    if (block.type === 'csv') enhanceCsv(card, block);
  });
  if (missing) scheduleRefresh();
}

async function refreshBlocks() {
  try {
    const response = await fetch(apiUrl('bootstrap'), { cache: 'no-store' });
    if (!response.ok) return;
    const snapshot = await response.json();
    blockMap.clear();
    [...(snapshot.notes || []), ...(snapshot.trash || [])].forEach((note) => {
      (note.blocks || []).forEach((block) => blockMap.set(block.id, block));
    });
    enhanceCards();
  } catch {}
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshBlocks, 250);
}

function addCsvButton() {
  const adder = document.querySelector('#block-adder');
  if (!adder || adder.querySelector('[data-add-block="csv"]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.addBlock = 'csv';
  button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM4 10h16M9 5v14M15 5v14"/></svg>Table';
  button.addEventListener('click', () => { pendingCsv = true; });
  const image = adder.querySelector('[data-add-block="image"]');
  adder.insertBefore(button, image || null);
}

function boot() {
  addCsvButton();
  refreshBlocks();
  const blocks = document.querySelector('#blocks');
  if (blocks) {
    blocks.addEventListener('pointerdown', (event) => {
      const card = event.target.closest('[data-block-id]');
      if (!card || offline()) return;
      card.draggable = Boolean(event.target.closest('.drag-handle'));
    }, true);
    blocks.addEventListener('dragend', () => {
      blocks.querySelectorAll('[data-block-id]').forEach((card) => { card.draggable = false; });
    }, true);
    new MutationObserver(enhanceCards).observe(blocks, { childList: true });
  }
  const save = document.querySelector('#save-status');
  if (save) new MutationObserver(() => {
    if (save.textContent.includes('Saved')) scheduleRefresh();
  }).observe(save, { childList: true, subtree: true, characterData: true });
  const offlineBanner = document.querySelector('#offline-banner');
  if (offlineBanner) new MutationObserver(enhanceCards).observe(offlineBanner, { attributes: true, attributeFilter: ['class'] });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
