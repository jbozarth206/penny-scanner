// Offline cache: app shell cache-first, penny-list.json network-first (falls back to cached copy in-store with bad signal).
const CACHE = 'penny-scanner-v1';
const SHELL = ['./', './index.html', './app.js', './vendor/zxing.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './penny-list.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('penny-list.json')) {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./penny-list.json', copy)); return r; })
      .catch(() => caches.match('./penny-list.json')));
    return;
  }
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(r => r || fetch(e.request)));
});
