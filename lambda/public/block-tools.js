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
  return rows.map((item) => [...item, ...Array(width - item.length).fill('')]);
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
  card.querySelectorAll('.csv-editor-table input, [data-csv-edit], .csv-generated-controls button').forEach((element) => {
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

function renderTable(card, rows) {
  const holder = card.querySelector('[data-csv-table]');
  if (!holder) return;
  const table = document.createElement('table');
  table.className = 'csv-editor-table';
  const body = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    row.forEach((value, columnIndex) => {
      const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
      const input = document.createElement('input');
      input.value = value;
      input.disabled = offline();
      input.setAttribute('aria-label', `Row ${rowIndex + 1}, column ${columnIndex + 1}`);
      input.addEventListener('input', (event) => {
        event.stopPropagation();
        rows[rowIndex][columnIndex] = input.value;
        syncSource(card, rows);
      });
      cell.append(input);
      tr.append(cell);
    });
    body.append(tr);
  });
  table.append(body);
  holder.replaceChildren(table);
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
  controls.append(
    actionButton('move-up', '↑', 'Move block up'),
    actionButton('move-down', '↓', 'Move block down'),
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
  const controls = ensureBlockControls(card);

  const toolbar = document.createElement('div');
  toolbar.className = 'csv-toolbar';
  const label = document.createElement('strong');
  label.textContent = 'CSV table';

  const addRow = editingButton('Add row', () => {
    rows.push(Array(rows[0]?.length || 1).fill(''));
    renderTable(card, rows);
    syncSource(card, rows);
  });

  const addColumn = editingButton('Add column', () => {
    rows.forEach((row) => row.push(''));
    renderTable(card, rows);
    syncSource(card, rows);
  });

  const removeRow = editingButton('Remove row', () => {
    if (rows.length <= 1) return;
    rows.pop();
    renderTable(card, rows);
    syncSource(card, rows);
  });

  const removeColumn = editingButton('Remove column', () => {
    if ((rows[0]?.length || 1) <= 1) return;
    rows.forEach((row) => row.pop());
    renderTable(card, rows);
    syncSource(card, rows);
  });

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'secondary-button';
  download.textContent = 'Download CSV';
  download.addEventListener('click', () => downloadCsv(serializeCsv(rows)));

  toolbar.append(label, addRow, addColumn, removeRow, removeColumn, download);

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
  renderTable(card, rows);
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
  if (blocks) new MutationObserver(enhanceCards).observe(blocks, { childList: true });
  const save = document.querySelector('#save-status');
  if (save) new MutationObserver(() => {
    if (save.textContent.includes('Saved')) scheduleRefresh();
  }).observe(save, { childList: true, subtree: true, characterData: true });
  const offlineBanner = document.querySelector('#offline-banner');
  if (offlineBanner) new MutationObserver(enhanceCards).observe(offlineBanner, { attributes: true, attributeFilter: ['class'] });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
