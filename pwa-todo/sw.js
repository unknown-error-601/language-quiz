const VERSION = 'v1.0.0';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/maskable.svg',
];
const CACHE_NAME = `app-shell-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('app-shell-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const resp = await fetch(event.request);
        if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'opaque')) {
          cache.put(event.request, resp.clone());
        }
        return resp;
      } catch (e) {
        // Offline fallback to index for navigation requests
        if (event.request.mode === 'navigate') {
          return cache.match('./index.html');
        }
        throw e;
      }
    })());
  }
});

async function readAllTasksFromIdb() {
  // Minimal IndexedDB accessor inside SW
  const DB_NAME = 'tasks-db';
  const STORE = 'tasks';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('dueAt', 'dueAt', { unique: false });
          store.createIndex('completed', 'completed', { unique: false });
          store.createIndex('remindedAt', 'remindedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const allReq = store.getAll();
    allReq.onsuccess = () => resolve(allReq.result || []);
    allReq.onerror = () => reject(allReq.error);
  });
}

function isDueSoon(dueAt, now) {
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  return dueAt - now <= threeDaysMs && dueAt >= now;
}

async function checkAndNotifyDeadlines() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  const tasks = await readAllTasksFromIdb();
  const now = Date.now();
  for (const t of tasks) {
    if (t.completed) continue;
    if (!t.notify) continue;
    const remindAt = t.dueAt - 3 * 24 * 60 * 60 * 1000;
    if (remindAt <= now && (!t.remindedAt || t.remindedAt < remindAt)) {
      self.registration.showNotification(`Upcoming: ${t.title}`, {
        body: `Due ${new Date(t.dueAt).toLocaleString()}`,
        tag: `task-${t.id}`,
        data: { id: t.id, dueAt: t.dueAt },
        icon: './icons/icon.svg',
        badge: './icons/icon.svg',
      });
      // best-effort write back remindedAt
      try {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open('tasks-db', 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        await new Promise((resolve) => {
          const tx = db.transaction('tasks', 'readwrite');
          tx.objectStore('tasks').put({ ...t, remindedAt: now });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
        });
      } catch {}
    }
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'task-deadlines') {
    event.waitUntil(checkAndNotifyDeadlines());
  }
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'checkDeadlines') {
    event.waitUntil(checkAndNotifyDeadlines());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length > 0) {
      all[0].focus();
      return;
    }
    await clients.openWindow('./');
  })());
});