import { getAllTasks, putTask, deleteTasks, markCompleted, uuid, computeRemindAt, isDueSoon } from './db.js';

const elements = {
  taskList: document.getElementById('taskList'),
  dueSoonSection: document.getElementById('dueSoonSection'),
  dueSoonList: document.getElementById('dueSoonList'),
  addTaskBtn: document.getElementById('addTaskBtn'),
  toggleDeleteBtn: document.getElementById('toggleDeleteBtn'),
  bulkDeleteBar: document.getElementById('bulkDeleteBar'),
  deleteSelectedBtn: document.getElementById('deleteSelectedBtn'),
  exitDeleteModeBtn: document.getElementById('exitDeleteModeBtn'),
  selectedCount: document.getElementById('selectedCount'),
  progressFill: document.getElementById('progressFill'),
  completedCount: document.getElementById('completedCount'),
  totalCount: document.getElementById('totalCount'),
  enableNotifBtn: document.getElementById('enableNotifBtn'),

  modalOverlay: document.getElementById('modalOverlay'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  taskForm: document.getElementById('taskForm'),
  taskTitle: document.getElementById('taskTitle'),
  taskDesc: document.getElementById('taskDesc'),
  taskDue: document.getElementById('taskDue'),
  taskImportance: document.getElementById('taskImportance'),
  importanceValue: document.getElementById('importanceValue'),
  taskNotify: document.getElementById('taskNotify'),
  cancelBtn: document.getElementById('cancelBtn'),
};

const state = {
  deleteMode: false,
  selectedIds: new Set(),
  inPageTimers: new Map(),
};

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function fmtRelativeTime(targetMs) {
  const now = Date.now();
  const diff = targetMs - now;
  const abs = Math.abs(diff);
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  let value, unit;
  if (abs >= day) { value = Math.round(abs / day); unit = 'd'; }
  else if (abs >= hour) { value = Math.round(abs / hour); unit = 'h'; }
  else { value = Math.round(abs / minute); unit = 'm'; }
  return diff >= 0 ? `in ${value}${unit}` : `${value}${unit} ago`;
}

function openModal() {
  elements.taskForm.reset();
  elements.importanceValue.textContent = elements.taskImportance.value;
  const rounded = new Date(Date.now() + 60 * 60 * 1000);
  rounded.setMinutes(0,0,0);
  elements.taskDue.value = new Date(rounded.getTime() + 60 * 60 * 1000).toISOString().slice(0,16);
  elements.modalOverlay.classList.remove('hidden');
}

function closeModal() {
  elements.modalOverlay.classList.add('hidden');
}

function updateProgress(tasks) {
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  elements.progressFill.style.width = pct + '%';
  elements.completedCount.textContent = String(completed);
  elements.totalCount.textContent = String(total);
}

function renderImportance(importance) {
  const level = Math.max(1, Math.min(10, Number(importance) || 1));
  const dots = '●'.repeat(Math.ceil(level / 2));
  return dots;
}

function createTaskItem(task) {
  const tpl = document.getElementById('taskItemTemplate');
  const node = tpl.content.firstElementChild.cloneNode(true);
  const completeToggle = node.querySelector('.complete-toggle');
  const titleEl = node.querySelector('.task-title');
  const dueEl = node.querySelector('.due');
  const descEl = node.querySelector('.task-desc');
  const importanceEl = node.querySelector('.importance');
  const dueSoonBadge = node.querySelector('.due-soon-badge');
  const selectWrap = node.querySelector('.select-for-delete');
  const selectDelete = node.querySelector('.select-delete');

  titleEl.textContent = task.title;
  importanceEl.textContent = renderImportance(task.importance);

  if (task.description) {
    descEl.textContent = task.description;
    descEl.hidden = false;
  }

  dueEl.textContent = `Due ${new Date(task.dueAt).toLocaleString()} (${fmtRelativeTime(task.dueAt)})`;
  if (isDueSoon(task.dueAt)) {
    dueSoonBadge.hidden = false;
  }

  completeToggle.checked = !!task.completed;
  completeToggle.addEventListener('change', async (e) => {
    await markCompleted(task.id, completeToggle.checked);
    await refresh();
  });

  // Delete mode handling
  selectWrap.hidden = !state.deleteMode;
  if (state.deleteMode) {
    selectDelete.checked = state.selectedIds.has(task.id);
    selectDelete.addEventListener('change', () => {
      if (selectDelete.checked) state.selectedIds.add(task.id);
      else state.selectedIds.delete(task.id);
      updateSelectedCount();
    });
  }

  return node;
}

async function renderLists() {
  const tasks = await getAllTasks();
  tasks.sort((a,b) => {
    // Incomplete first, then nearest due
    if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
    return (a.dueAt || 0) - (b.dueAt || 0);
  });

  elements.taskList.innerHTML = '';
  tasks.forEach(task => {
    elements.taskList.appendChild(createTaskItem(task));
  });

  // Due soon section
  const dueSoon = tasks.filter(t => isDueSoon(t.dueAt) && !t.completed);
  if (dueSoon.length > 0) {
    elements.dueSoonList.innerHTML = '';
    dueSoon.slice(0, 10).forEach(task => {
      const node = createTaskItem(task);
      elements.dueSoonList.appendChild(node);
    });
    elements.dueSoonSection.hidden = false;
  } else {
    elements.dueSoonSection.hidden = true;
  }

  updateProgress(tasks);
}

function updateSelectedCount() {
  elements.selectedCount.textContent = `${state.selectedIds.size} selected`;
  elements.bulkDeleteBar.classList.toggle('hidden', state.selectedIds.size === 0);
}

function setDeleteMode(on) {
  state.deleteMode = on;
  state.selectedIds.clear();
  updateSelectedCount();
  renderLists();
}

async function scheduleReminder(task) {
  if (!task.notify) return;
  const remindAt = computeRemindAt(task.dueAt);
  if (remindAt <= 0) return;

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    // Experimental Notification Triggers API (may not be available)
    if (typeof window !== 'undefined' && 'showTrigger' in Notification.prototype && 'TimestampTrigger' in window) {
      try {
        await reg.showNotification(`Upcoming: ${task.title}`, {
          body: `Due ${new Date(task.dueAt).toLocaleString()}`,
          tag: `task-${task.id}`,
          data: { id: task.id, dueAt: task.dueAt },
          showTrigger: new TimestampTrigger(remindAt),
          icon: './icons/icon.svg',
          badge: './icons/icon.svg',
        });
        return;
      } catch {}
    }

    // Page-alive fallback: schedule a timeout for this session
    const timeoutMs = Math.max(0, remindAt - Date.now());
    if (timeoutMs < THREE_DAYS_MS) {
      if (state.inPageTimers.has(task.id)) clearTimeout(state.inPageTimers.get(task.id));
      const id = setTimeout(async () => {
        const reg2 = await navigator.serviceWorker.getRegistration();
        if (reg2) {
          reg2.showNotification(`Upcoming: ${task.title}`, {
            body: `Due ${new Date(task.dueAt).toLocaleString()}`,
            tag: `task-${task.id}`,
            data: { id: task.id, dueAt: task.dueAt },
            icon: './icons/icon.svg',
            badge: './icons/icon.svg',
          });
        }
      }, timeoutMs);
      state.inPageTimers.set(task.id, id);
    }
  } catch (e) {
    // Ignore scheduling issues
  }
}

async function ensurePeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) {
      try {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await reg.periodicSync.register('task-deadlines', { minInterval: 6 * 60 * 60 * 1000 });
        }
      } catch {}
    }
  } catch {}
}

async function refresh() {
  await renderLists();
}

function bindEvents() {
  elements.addTaskBtn.addEventListener('click', openModal);
  elements.closeModalBtn.addEventListener('click', closeModal);
  elements.cancelBtn.addEventListener('click', closeModal);
  elements.taskImportance.addEventListener('input', () => {
    elements.importanceValue.textContent = elements.taskImportance.value;
  });

  elements.toggleDeleteBtn.addEventListener('click', () => setDeleteMode(!state.deleteMode));
  elements.exitDeleteModeBtn.addEventListener('click', () => setDeleteMode(false));
  elements.deleteSelectedBtn.addEventListener('click', async () => {
    if (state.selectedIds.size === 0) return;
    const ids = [...state.selectedIds];
    await deleteTasks(ids);
    setDeleteMode(false);
    await refresh();
  });

  elements.taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = elements.taskTitle.value.trim();
    const description = elements.taskDesc.value.trim();
    const dueStr = elements.taskDue.value;
    const dueAt = new Date(dueStr).getTime();
    const importance = Number(elements.taskImportance.value) || 5;
    const notify = elements.taskNotify.checked;
    if (!title || Number.isNaN(dueAt)) return;

    const task = {
      id: uuid(),
      title,
      description,
      dueAt,
      importance,
      notify,
      completed: false,
      createdAt: Date.now(),
      remindedAt: undefined,
    };

    await putTask(task);
    closeModal();
    await refresh();
    scheduleReminder(task);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function setupNotificationsUi() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  elements.enableNotifBtn.hidden = false;
  elements.enableNotifBtn.addEventListener('click', async () => {
    const res = await Notification.requestPermission();
    if (res === 'granted') {
      elements.enableNotifBtn.hidden = true;
    }
  }, { once: true });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    ensurePeriodicSync();
  } catch (e) {
    // ignore
  }
}

async function bootstrap() {
  bindEvents();
  setupNotificationsUi();
  await registerServiceWorker();
  await refresh();

  // Kick a periodic check while page is open
  setInterval(() => {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'checkDeadlines' });
    }
  }, 60 * 60 * 1000); // hourly
}

bootstrap();

