const DB_NAME = 'tasks-db';
const DB_VERSION = 1;
const STORE = 'tasks';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('dueAt', 'dueAt', { unique: false });
        store.createIndex('completed', 'completed', { unique: false });
        store.createIndex('remindedAt', 'remindedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store, tx);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllTasks() {
  const db = await openDb();
  return withStore(db, 'readonly', (store) => store.getAll());
}

export async function putTask(task) {
  const db = await openDb();
  return withStore(db, 'readwrite', (store) => store.put(task));
}

export async function deleteTasks(ids) {
  const db = await openDb();
  return withStore(db, 'readwrite', (store, tx) => {
    ids.forEach((id) => store.delete(id));
  });
}

export async function markCompleted(id, completed) {
  const db = await openDb();
  const task = await withStore(db, 'readonly', (store) => store.get(id));
  if (!task) return;
  task.completed = !!completed;
  task.completedAt = task.completed ? Date.now() : undefined;
  return withStore(db, 'readwrite', (store) => store.put(task));
}

export function uuid() {
  // RFC4122 v4-ish, sufficient for IDs here
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

export function computeRemindAt(dueAt) {
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  return Math.max(0, dueAt - threeDaysMs);
}

export function isDueSoon(dueAt, now = Date.now()) {
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  return dueAt - now <= threeDaysMs && dueAt >= now;
}

