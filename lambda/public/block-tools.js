const APP_BASE = new URL('.', import.meta.url);
const blockMap = new Map();
let pendingCsv = false;
let refreshTimer = null;
const controlIcons = {
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m7 14 5-5 5 5"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="7" r=".7"/><circle cx="15" cy="7" r=".7"/><circle cx="9" cy="12" r=".7"/><circle cx="15" cy="12" r=".7"/><circle cx="9" cy="17" r=".7"/><circle cx="15" cy="17" r=".7"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
};

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

function safeFilename(value, fallback = 'lambda-table') {
  return String(value || fallback).trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '') || fallback;
}

function downloadCsv(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilename(filename, 'lambda-table')}.csv`;
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
  card.querySelectorAll('.csv-cell-input, .csv-header-name, .csv-table-name, [data-csv-edit], .csv-generated-controls button').forEach((element) => {
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
  const values = rows.slice(1).map((row, index) => ({ row, sourceIndex: index + 1 }));
  const filtered = values.filter(({ row }) => {
    if (globalFilter && !row.some((value) => String(value ?? '').toLocaleLowerCase().includes(globalFilter))) return false;
    return true;
  });
  if (state.sortColumn === null || !state.sortDirection) return filtered;
  return filtered.sort((left, right) => {
    const compared = compareValues(left.row[state.sortColumn], right.row[state.sortColumn]);
    return compared ? compared * state.sortDirection : left.sourceIndex - right.sourceIndex;
  });
}

function moveCsvCell(input, key) {
  const cell = input.closest('td');
  const row = input.closest('tr');
  if (!cell || !row) return false;

  let target;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const targetRow = key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    target = targetRow?.cells[cell.cellIndex]?.querySelector('.csv-cell-input');
  } else {
    const targetCell = key === 'ArrowLeft' ? cell.previousElementSibling : cell.nextElementSibling;
    target = targetCell?.querySelector('.csv-cell-input');
  }
  if (!target) return false;

  target.focus();
  return true;
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
      input.addEventListener('keydown', (event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        if (!moveCsvCell(input, event.key)) return;
        event.preventDefault();
      });
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

    top.append(name, sort);
    cell.append(top);
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

function actionButton(role, label, title, icon = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `block-control${role === 'remove' ? ' remove' : ''}${role === 'copy' ? ' copy-control' : ''}${role === 'download-csv' ? ' download-control' : ''}`;
  button.dataset.role = role;
  button.title = title;
  button.setAttribute('aria-label', title);
  if (icon) {
    button.innerHTML = icon;
    if (role === 'copy') {
      const copyLabel = document.createElement('span');
      copyLabel.dataset.copyLabel = '';
      copyLabel.textContent = label;
      button.append(copyLabel);
    }
  } else button.textContent = label;
  return button;
}

function ensureBlockControls(card) {
  let controls = card.querySelector('.block-controls');
  if (controls) return controls;
  controls = document.createElement('div');
  controls.className = 'block-controls csv-generated-controls';
  const drag = actionButton('drag', '', 'Drag to reorder', controlIcons.grip);
  drag.classList.add('drag-handle');
  controls.append(
    actionButton('copy', 'Copy', 'Copy table', controlIcons.copy),
    actionButton('move-up', '', 'Move block up', controlIcons.up),
    actionButton('move-down', '', 'Move block down', controlIcons.down),
    drag,
    actionButton('remove', '', 'Remove block', controlIcons.remove),
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
    globalFilter: '',
  };
  const controls = ensureBlockControls(card);

  const downloadControl = actionButton('download-csv', '', 'Download CSV', controlIcons.download);
  const tableName = document.createElement('input');
  tableName.type = 'text';
  tableName.className = 'csv-table-name';
  tableName.dataset.role = 'name';
  tableName.maxLength = 200;
  tableName.value = block.name || 'CSV table';
  tableName.placeholder = 'Table name';
  tableName.setAttribute('aria-label', 'Table name');
  tableName.disabled = offline();
  tableName.addEventListener('input', () => {
    block.name = tableName.value;
  });
  downloadControl.addEventListener('click', () => downloadCsv(serializeCsv(rows), tableName.value));
  controls.insertBefore(downloadControl, controls.children[1] || null);

  const toolbar = document.createElement('div');
  toolbar.className = 'csv-toolbar';
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
  clearFilters.textContent = 'Clear filter';
  clearFilters.addEventListener('click', () => {
    tableState.globalFilter = '';
    globalFilter.value = '';
    renderTableBody(card, rows, tableState);
  });

  const addRow = editingButton('Add row', () => {
    rows.push(Array(rows[0]?.length || 1).fill(''));
    renderTableBody(card, rows, tableState);
    syncSource(card, rows);
  });

  const addColumn = editingButton('Add column', () => {
    rows.forEach((row) => row.push(''));
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

  toolbar.append(tableName, globalFilter, clearFilters, addRow, addColumn, removeRow, removeColumn);

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
  let pendingCopy = null;
  let statusTimer = null;
  const original = block.code;
  const copyValue = async (value, status) => {
    try {
      await navigator.clipboard.writeText(value);
      badge.textContent = status;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { if (badge.isConnected) badge.textContent = original; }, 900);
    } catch {}
  };
  badge.addEventListener('click', (event) => {
    if (event.detail > 1) {
      clearTimeout(pendingCopy);
      pendingCopy = null;
      copyValue(`Get-LambdaBlock -Code ${block.code} | Select-Object block`, 'PS copied');
      return;
    }
    clearTimeout(pendingCopy);
    pendingCopy = setTimeout(() => {
      pendingCopy = null;
      copyValue(block.code, 'Copied');
    }, 300);
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

function addBackToTopButton() {
  if (document.querySelector('[data-back-to-top]')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'back-to-top';
  button.dataset.backToTop = '';
  button.title = 'Return to top';
  button.setAttribute('aria-label', 'Return to top');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>';

  const updateVisibility = () => {
    const appVisible = !document.querySelector('#app-shell')?.classList.contains('hidden');
    button.classList.toggle('visible', appVisible && window.scrollY > 480);
  };

  button.addEventListener('click', () => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  });
  window.addEventListener('scroll', updateVisibility, { passive: true });
  window.addEventListener('resize', updateVisibility);
  document.body.append(button);
  updateVisibility();
}

function boot() {
  addCsvButton();
  addBackToTopButton();
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
