/* Service worker — lets the installed phone app open and work with no network.
   Bump CACHE when app.js / styles.css / auth.js change so phones pick up the new build. */
const CACHE = 'shiv-travels-v4';
const ASSETS = [
  './', './index.html', './styles.css', './auth.js', './app.js',
  './manifest.webmanifest', './icon.svg', './icon-maskable.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network first, cache as the offline fallback — so an updated deploy is picked up
// straight away when there is signal, and the app still opens when there is none
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
