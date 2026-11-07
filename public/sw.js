// App-shell cache. API calls are never cached (always live, per-user).
const CACHE = 'manna-v7';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // stale-while-revalidate for the shell
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: false });
      const net = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || (req.mode === 'navigate' ? cache.match('/') : undefined));
      return hit || net;
    }),
  );
});

// ---- push notifications ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { /* plain text or empty */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Manna', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
    const c = list.find((w) => w.url.startsWith(self.location.origin));
    if (c) { await c.focus(); return c.navigate(url).catch(() => {}); }
    return self.clients.openWindow(url);
  }));
});
