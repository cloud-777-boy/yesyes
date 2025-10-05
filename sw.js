const CACHE_VERSION = 'pixel-mage-arena-v1';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/terrain.js',
  '/physics.js',
  '/player.js',
  '/projectile.js',
  '/engine.js',
  '/network.js',
  '/input.js',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-180.png',
  '/icons/icon-96.png',
  '/icons/icon-72.png',
  '/icons/icon-48.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(async (cache) => {
        for (const asset of CORE_ASSETS) {
          try {
            await cache.add(asset);
          } catch (error) {
            console.warn('[SW] Failed to precache', asset, error);
          }
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(request, clone).catch(() => {});
          });
          return response;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
