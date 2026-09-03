/* Mana Market service worker: offline shell, cached market pack, push alerts. */
const SHELL = 'mm-shell-v1';
const DATA = 'mm-data-v1';
const IMGS = 'mm-img-v1';

// Paths are relative to the service worker's scope, so the same file works at a
// domain root and under a GitHub Pages sub-path.
const ROOT = new URL('./', self.location).href;
const SHELL_FILES = [
  './', './index.html', './css/app.css',
  './js/app.js', './js/data.js', './js/scryfall.js', './js/store.js', './js/ui.js', './js/alerts.js',
  './js/views/market.js', './js/views/trends.js', './js/views/search.js',
  './js/views/card.js', './js/views/watchlist.js', './js/views/deck.js',
  './manifest.webmanifest', './icons/icon.svg',
].map((f) => new URL(f, ROOT).href);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, DATA, IMGS];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never cache Scryfall JSON — prices must stay honest.
  if (url.hostname === 'api.scryfall.com') return;

  // Card images: cache first, they are immutable.
  if (url.hostname === 'cards.scryfall.io') {
    event.respondWith(cacheFirst(request, IMGS, 400));
    return;
  }

  // Market pack: stale-while-revalidate. Range requests bypass the cache.
  if (url.href.startsWith(`${ROOT}data/`)) {
    if (request.headers.has('range')) return;
    event.respondWith(staleWhileRevalidate(request, DATA));
    return;
  }

  // App shell: cache first, fall back to network, then to the shell document.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok && res.type === 'basic') {
          const cache = await caches.open(SHELL);
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        const shell = await caches.match(new URL('./index.html', ROOT).href);
        if (shell && request.mode === 'navigate') return shell;
        throw new Error('offline');
      }
    })());
  }
});

async function cacheFirst(request, cacheName, cap) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    cache.put(request, res.clone());
    trim(cache, cap);
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await network) || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
}

async function trim(cache, cap) {
  const keys = await cache.keys();
  if (keys.length <= cap) return;
  await Promise.all(keys.slice(0, keys.length - cap).map((k) => cache.delete(k)));
}

// ------------------------------------------------------------------ push
self.addEventListener('push', (event) => {
  let payload = { title: 'Mana Market', body: 'A watched card moved.', url: ROOT };
  try { payload = { ...payload, ...event.data.json() }; } catch { /* text payload */ }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag || 'mm-alert',
    icon: new URL('./icons/icon-192.png', ROOT).href,
    badge: new URL('./icons/badge-72.png', ROOT).href,
    data: { url: payload.url || ROOT },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', ROOT).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hit = all.find((c) => c.url.startsWith(ROOT));
    if (hit) { await hit.focus(); return hit.navigate(target); }
    return self.clients.openWindow(target);
  })());
});
