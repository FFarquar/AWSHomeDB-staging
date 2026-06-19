const CACHE_NAME = 'homedb-v226';

const PRECACHE_ASSETS = [
  './login.html',
  './containers.html',
  './containers.css',
  './containers.js',
  './apiClient.js',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Install: precache the app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove stale caches from previous versions
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for same-origin assets, network-first for API calls
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // API calls (cross-origin to API Gateway): network-first, silent offline fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', message: 'No network connection' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Same-origin static assets: cache-first, fall back to network and cache result
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, response.clone()));
        }
        return response;
      });
    })
  );
});
