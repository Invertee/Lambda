const APP_BASE = new URL('.', import.meta.url);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  todos: [],
  loaded: false,
  completedLoaded: false,
  completedExpanded: false,
  showing: false,
  draggingId: '',
  savingOrder: false,
};

function apiUrl(path = '') {
  return new URL(`api/${path.replace(/^\//, '')}`, APP_BASE);
}

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

function ensureUi() {
  const filterNav = $('.filter-nav');
  const workspace = $('.workspace');
  const offlineBanner = $('#offline-banner');
  if (!filterNav || !workspace || !offlineBanner) return false;

  if (!$('#todos-nav')) {
    const button = document.createElement('button');
    button.id = 'todos-nav';
    button.type = 'button';
    button.className = 'nav-item';
    button.innerHTML = `
      <span>
        <svg viewBox="0 0 24 24"><circle cx="6.5" cy="7" r="2.5"/><path d="m5.4 7 1 1 2-2M11 7h8M5 14h14M5 18h10"/></svg>
        To-Dos
      </span>
      <span id="todos-count" class="count">0</span>
    `;
    filterNav.prepend(button);
  }

  if (!$('#todos-view')) {
    const section = document.createElement('section');
    section.id = 'todos-view';
    section.className = 'todos-view hidden';
    section.innerHTML = `
      <header class="page-header todos-header">
        <p class="eyebrow">TASKS</p>
        <h1>To-Dos</h1>
        <p>Track active work, due dates, and smaller steps without mixing tasks into your notes.</p>
      </header>

      <form id="todo-create-form" class="todo-create-form">
        <label class="todo-create-title">
          <span>New to-do</span>
          <input id="todo-create-title" maxlength="300" placeholder="Add a task" autocomplete="off" required>
        </label>
        <label class="todo-create-date">
          <span>Due date</span>
          <input id="todo-create-due" type="date">
        </label>
        <button class="primary-button" type="submit">Add to-do</button>
      </form>

      <section class="todo-section" aria-labelledby="active-todos-heading">
        <div class="todo-section-heading">
          <div>
            <p class="eyebrow">ACTIVE</p>
            <h2 id="active-todos-heading">To-Dos</h2>
          </div>
          <span id="active-todos-count" class="todo-section-count"></span>
        </div>
        <div id="active-todos-list" class="todo-list"></div>
      </section>

      <section class="todo-section todo-completed-section" aria-labelledby="completed-todos-heading">
        <button id="completed-todos-toggle" class="todo-completed-toggle" type="button" aria-expanded="false">
          <span>
            <svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>
            <strong id="completed-todos-heading">Completed</strong>
            <span id="completed-todos-count" class="todo-section-count"></span>
          </span>
          <span>Show</span>
        </button>
        <div id="completed-todos-panel" class="hidden">
          <div class="todo-completed-actions">
            <button id="clear-completed-todos" class="secondary-button" type="button">Clear completed</button>
          </div>
          <div id="completed-todos-list" class="todo-list"></div>
        </div>
      </section>
    `;
    offlineBanner.insertAdjacentElement('afterend', section);
  }

  return true;
}

function mainViews() {
  return ['#empty-state', '#library-view', '#note-editor', '#trash-view']
    .map((selector) => $(selector))
    .filter(Boolean);
}

function hideTodoView() {
  const view = $('#todos-view');
  if (!view || view.classList.contains('hidden')) return;
  view.classList.add('hidden');
  $('#todos-nav')?.classList.remove('active');
  state.showing = false;
}

async function showTodoView() {
  mainViews().forEach((view) => view.classList.add('hidden'));
  $('#todos-view').classList.remove('hidden');
  $('#todos-nav').classList.add('active');
  state.showing = true;
  $('#sidebar')?.classList.remove('open');
  document.body.classList.remove('sidebar-open');
  await refreshActiveTodos();
  if (state.completedExpanded) await refreshCompletedTodos();
}

function formatDue(todo) {
  if (!todo.dueDate) return '';
  const due = new Date(`${todo.dueDate}T00:00:00`);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (todo.dueDate === todayKey) return 'Due today';
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  if (todo.dueDate === tomorrowKey) return 'Due tomorrow';
  const label = due.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: due.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  return todo.dueDate < todayKey ? `Overdue · ${label}` : `Due ${label}`;
}

function dragHandle() {
  const drag = document.createElement('button');
  drag.type = 'button';
  drag.className = 'todo-drag-handle';
  drag.dataset.todoDrag = '';
  drag.title = 'Drag to change priority';
  drag.setAttribute('aria-label', 'Drag to change priority');
  drag.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
  return drag;
}

function todoCard(todo) {
  const card = document.createElement('article');
  card.className = `todo-card${todo.completed ? ' completed' : ''}`;
  card.dataset.todoId = todo.id;
  card.dataset.priority = String(todo.priority || 0);
  card.draggable = false;

  const main = document.createElement('div');
  main.className = `todo-main-row${todo.completed ? '' : ' priority-enabled'}`;

  const complete = document.createElement('input');
  complete.type = 'checkbox';
  complete.className = 'todo-complete-checkbox';
  complete.dataset.todoComplete = '';
  complete.checked = todo.completed;
  complete.setAttribute('aria-label', todo.completed ? 'Reopen to-do' : 'Complete to-do');

  const body = document.createElement('div');
  body.className = 'todo-card-body';

  const title = document.createElement('input');
  title.className = 'todo-title-input';
  title.dataset.todoTitle = '';
  title.maxLength = 300;
  title.value = todo.title;
  title.setAttribute('aria-label', 'To-do title');

  const meta = document.createElement('div');
  meta.className = 'todo-meta-row';
  const dueLabel = document.createElement('span');
  dueLabel.className = `todo-due-label${todo.dueDate && !todo.completed && formatDue(todo).startsWith('Overdue') ? ' overdue' : ''}`;
  dueLabel.textContent = formatDue(todo) || 'No due date';
  const dueInput = document.createElement('input');
  dueInput.type = 'date';
  dueInput.className = 'todo-due-input';
  dueInput.dataset.todoDue = '';
  dueInput.value = todo.dueDate || '';
  dueInput.setAttribute('aria-label', 'Due date');
  meta.append(dueLabel, dueInput);

  const subtasks = document.createElement('div');
  subtasks.className = 'todo-subtasks';
  todo.subtasks.forEach((subtask) => subtasks.append(subtaskRow(subtask)));

  const addStep = document.createElement('button');
  addStep.type = 'button';
  addStep.className = 'todo-add-step';
  addStep.dataset.addSubtask = '';
  addStep.textContent = '+ Add step';

  body.append(title, meta, subtasks, addStep);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button danger-hover todo-delete';
  remove.dataset.deleteTodo = '';
  remove.title = 'Delete to-do';
  remove.setAttribute('aria-label', 'Delete to-do');
  remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>';

  if (!todo.completed) main.append(dragHandle());
  main.append(complete, body, remove);
  card.append(main);
  return card;
}

function subtaskRow(subtask) {
  const row = document.createElement('div');
  row.className = `todo-subtask${subtask.completed ? ' completed' : ''}`;
  row.dataset.subtaskId = subtask.id;

  const complete = document.createElement('input');
  complete.type = 'checkbox';
  complete.dataset.subtaskComplete = '';
  complete.checked = Boolean(subtask.completed);
  complete.setAttribute('aria-label', 'Complete subtask');

  const title = document.createElement('input');
  title.className = 'todo-subtask-title';
  title.dataset.subtaskTitle = '';
  title.maxLength = 300;
  title.value = subtask.title || '';
  title.placeholder = 'New step';
  title.setAttribute('aria-label', 'Subtask title');

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'todo-subtask-remove';
  remove.dataset.removeSubtask = '';
  remove.setAttribute('aria-label', 'Remove subtask');
  remove.textContent = '×';

  row.append(complete, title, remove);
  return row;
}

function renderTodos() {
  const active = state.todos.filter((todo) => !todo.completed);
  const completed = state.todos.filter((todo) => todo.completed);

  $('#todos-count').textContent = active.length;
  $('#active-todos-count').textContent = `${active.length} active`;
  $('#completed-todos-count').textContent = state.completedLoaded ? `${completed.length}` : '';
  $('#clear-completed-todos').disabled = !state.completedLoaded || completed.length === 0;

  if (active.length) {
    $('#active-todos-list').replaceChildren(...active.map(todoCard));
  } else {
    const empty = document.createElement('div');
    empty.className = 'todo-empty';
    empty.innerHTML = '<strong>Nothing active</strong><span>Add a to-do above or enjoy the clear list.</span>';
    $('#active-todos-list').replaceChildren(empty);
  }

  if (state.completedLoaded && completed.length) {
    $('#completed-todos-list').replaceChildren(...completed.map(todoCard));
  } else {
    const empty = document.createElement('div');
    empty.className = 'todo-empty compact';
    empty.textContent = state.completedLoaded ? 'No completed to-dos yet.' : 'Completed to-dos load when this section is opened.';
    $('#completed-todos-list').replaceChildren(empty);
  }

  $('#completed-todos-panel').classList.toggle('hidden', !state.completedExpanded);
  $('#completed-todos-toggle').classList.toggle('expanded', state.completedExpanded);
  $('#completed-todos-toggle').setAttribute('aria-expanded', String(state.completedExpanded));
  $('#completed-todos-toggle > span:last-child').textContent = state.completedExpanded ? 'Hide' : 'Show';
}

async function refreshActiveTodos() {
  try {
    const active = await api('todos');
    const completed = state.todos.filter((todo) => todo.completed);
    state.todos = [...active, ...completed];
    state.loaded = true;
    renderTodos();
  } catch (error) {
    if (state.showing) {
      const empty = document.createElement('div');
      empty.className = 'todo-empty error';
      empty.textContent = error.message || 'To-Dos could not be loaded.';
      $('#active-todos-list').replaceChildren(empty);
    }
  }
}

async function refreshCompletedTodos() {
  try {
    const completed = await api('todos?completed=1');
    const active = state.todos.filter((todo) => !todo.completed);
    state.todos = [...active, ...completed];
    state.completedLoaded = true;
    renderTodos();
  } catch (error) {
    if (state.showing) {
      const empty = document.createElement('div');
      empty.className = 'todo-empty error';
      empty.textContent = error.message || 'Completed To-Dos could not be loaded.';
      $('#completed-todos-list').replaceChildren(empty);
    }
  }
}

function currentTodo(id) {
  return state.todos.find((todo) => todo.id === id);
}

function subtasksFromCard(card) {
  return $$('.todo-subtask', card).map((row) => ({
    id: row.dataset.subtaskId || crypto.randomUUID(),
    title: $('[data-subtask-title]', row).value.trim(),
    completed: $('[data-subtask-complete]', row).checked,
  })).filter((subtask) => subtask.title);
}

async function patchTodo(id, changes) {
  const updated = await api(`todos/${id}`, { method: 'PATCH', body: JSON.stringify(changes) });
  const index = state.todos.findIndex((todo) => todo.id === id);
  if (index >= 0) state.todos[index] = updated;
  else state.todos.push(updated);
  renderTodos();
  return updated;
}

async function createTodo(event) {
  event.preventDefault();
  const title = $('#todo-create-title').value.trim();
  if (!title) return;
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true;
  try {
    const created = await api('todos', {
      method: 'POST',
      body: JSON.stringify({ title, dueDate: $('#todo-create-due').value || null, subtasks: [] }),
    });
    state.todos.push(created);
    $('#todo-create-title').value = '';
    $('#todo-create-due').value = '';
    renderTodos();
    $('#todo-create-title').focus();
  } catch (error) {
    window.alert(error.message || 'To-do could not be created.');
  } finally {
    button.disabled = false;
  }
}

async function handleTodoChange(event) {
  const card = event.target.closest('[data-todo-id]');
  if (!card) return;
  const id = card.dataset.todoId;
  try {
    if (event.target.matches('[data-todo-complete]')) {
      await patchTodo(id, { completed: event.target.checked });
      return;
    }
    if (event.target.matches('[data-todo-title]')) {
      const title = event.target.value.trim();
      if (!title) {
        event.target.value = currentTodo(id)?.title || '';
        return;
      }
      await patchTodo(id, { title });
      return;
    }
    if (event.target.matches('[data-todo-due]')) {
      await patchTodo(id, { dueDate: event.target.value || null });
      return;
    }
    if (event.target.matches('[data-subtask-complete], [data-subtask-title]')) {
      await patchTodo(id, { subtasks: subtasksFromCard(card) });
    }
  } catch (error) {
    window.alert(error.message || 'To-do could not be updated.');
    await refreshActiveTodos();
    if (state.completedLoaded) await refreshCompletedTodos();
  }
}

async function handleTodoClick(event) {
  const card = event.target.closest('[data-todo-id]');
  const id = card?.dataset.todoId;

  if (event.target.closest('[data-add-subtask]') && card) {
    const container = $('.todo-subtasks', card);
    const row = subtaskRow({ id: crypto.randomUUID(), title: '', completed: false });
    container.append(row);
    $('[data-subtask-title]', row).focus();
    return;
  }

  if (event.target.closest('[data-remove-subtask]') && card) {
    event.target.closest('.todo-subtask')?.remove();
    try { await patchTodo(id, { subtasks: subtasksFromCard(card) }); }
    catch (error) {
      window.alert(error.message || 'Subtask could not be removed.');
      await refreshActiveTodos();
      if (state.completedLoaded) await refreshCompletedTodos();
    }
    return;
  }

  if (event.target.closest('[data-delete-todo]') && card) {
    if (!window.confirm('Delete this to-do permanently?')) return;
    try {
      await api(`todos/${id}`, { method: 'DELETE' });
      state.todos = state.todos.filter((todo) => todo.id !== id);
      renderTodos();
    } catch (error) {
      window.alert(error.message || 'To-do could not be deleted.');
    }
  }
}

function enableTodoDrag(event) {
  const handle = event.target.closest('[data-todo-drag]');
  if (!handle) return;
  const card = handle.closest('[data-todo-id]');
  if (card && !card.classList.contains('completed')) card.draggable = true;
}

function handleTodoDragStart(event) {
  const card = event.target.closest('#active-todos-list [data-todo-id]');
  if (!card || !card.draggable) {
    event.preventDefault();
    return;
  }
  state.draggingId = card.dataset.todoId;
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.draggingId);
}

function handleTodoDragOver(event) {
  if (!state.draggingId) return;
  const list = event.target.closest('#active-todos-list');
  if (!list) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  const dragging = $('.todo-card.dragging', list);
  const target = event.target.closest('.todo-card:not(.dragging)');
  if (!dragging || !target || target.parentElement !== list) return;
  const rect = target.getBoundingClientRect();
  if (event.clientY < rect.top + rect.height / 2) target.before(dragging);
  else target.after(dragging);
}

async function saveTodoOrder() {
  if (!state.draggingId || state.savingOrder) return;
  state.savingOrder = true;
  const list = $('#active-todos-list');
  const ids = $$('.todo-card[data-todo-id]', list).map((card) => card.dataset.todoId);
  try {
    const active = await api('todos/order', { method: 'PUT', body: JSON.stringify({ ids }) });
    const completed = state.todos.filter((todo) => todo.completed);
    state.todos = [...active, ...completed];
  } catch (error) {
    window.alert(error.message || 'To-do priority could not be saved.');
    await refreshActiveTodos();
  } finally {
    state.draggingId = '';
    state.savingOrder = false;
    renderTodos();
  }
}

function handleTodoDragEnd(event) {
  const card = event.target.closest('[data-todo-id]');
  if (card) {
    card.classList.remove('dragging');
    card.draggable = false;
  }
  saveTodoOrder();
}

async function clearCompleted() {
  if (!state.completedLoaded || !state.todos.some((todo) => todo.completed)) return;
  if (!window.confirm('Clear every completed to-do? This cannot be undone.')) return;
  try {
    await api('todos/completed', { method: 'DELETE' });
    state.todos = state.todos.filter((todo) => !todo.completed);
    renderTodos();
  } catch (error) {
    window.alert(error.message || 'Completed to-dos could not be cleared.');
  }
}

function wire() {
  if (!ensureUi()) return;

  $('#todos-nav').addEventListener('click', showTodoView);
  $('#todo-create-form').addEventListener('submit', createTodo);
  $('#todos-view').addEventListener('change', handleTodoChange);
  $('#todos-view').addEventListener('click', handleTodoClick);
  $('#todos-view').addEventListener('pointerdown', enableTodoDrag);
  $('#todos-view').addEventListener('dragstart', handleTodoDragStart);
  $('#todos-view').addEventListener('dragover', handleTodoDragOver);
  $('#todos-view').addEventListener('drop', (event) => event.preventDefault());
  $('#todos-view').addEventListener('dragend', handleTodoDragEnd);
  document.addEventListener('pointerup', () => {
    $$('.todo-card[draggable="true"]', $('#active-todos-list')).forEach((card) => {
      if (!card.classList.contains('dragging')) card.draggable = false;
    });
  });
  $('#completed-todos-toggle').addEventListener('click', async () => {
    state.completedExpanded = !state.completedExpanded;
    renderTodos();
    if (state.completedExpanded && !state.completedLoaded) await refreshCompletedTodos();
  });
  $('#clear-completed-todos').addEventListener('click', clearCompleted);

  const viewObserver = new MutationObserver(() => {
    if (!state.showing) return;
    if (mainViews().some((view) => !view.classList.contains('hidden'))) hideTodoView();
  });
  mainViews().forEach((view) => viewObserver.observe(view, { attributes: true, attributeFilter: ['class'] }));

  const shell = $('#app-shell');
  const shellObserver = new MutationObserver(() => {
    if (!shell.classList.contains('hidden') && !state.loaded) refreshActiveTodos();
  });
  shellObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
  if (!shell.classList.contains('hidden')) refreshActiveTodos();
}

wire();
