'use strict';
/**
 * ============================================================================
 *  spatial-worker.js — offline service worker for the Spatial Vault PWA.
 * ----------------------------------------------------------------------------
 *  Caching strategy (deliberately split, so a redeploy is never masked):
 *
 *    - App shell (documents + .js)  -> NETWORK-FIRST, cache fallback.
 *        A redeployed bugfix always wins while online, and the app still
 *        boots when offline. (Cache-first here is what makes people think
 *        "I fixed it but the browser still runs the old file".)
 *
 *    - Spatial data (.dat + manifest.dat) -> CACHE-FIRST.
 *        Tiles are immutable per build and content-addressed by Geohash
 *        prefix, so serving them from cache is correct and fast.
 *
 *    - Everything else (OSM tiles, unpkg CDN) -> straight passthrough.
 *
 *  IMPORTANT: after running `node spatial-vault.js` with changed data, bump
 *  CACHE_VERSION below so clients drop the previous tile set.
 *
 *  REGISTER (from a page on the same origin):
 *      if ('serviceWorker' in navigator) {
 *        navigator.serviceWorker.register('/spatial-worker.js', { scope: '/' });
 *      }
 * ============================================================================
 */

const CACHE_VERSION = 'spatial-vault-v2';

// Only real, same-origin files — one 404 would otherwise fail the whole install.
const APP_SHELL = [
  '/frontend/demo.html',
  '/frontend/dashboard.html',
  '/spatial-vault.client.js',
  '/spatial-vault.map.js',
];

/** True for decrypted-at-rest data assets we want to cache indefinitely. */
function isDataAsset(url) {
  return url.origin === self.location.origin && /\.dat$/.test(url.pathname);
}

/* --------------------------------------------------------------------------
 *  install
 * ------------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Add individually: `cache.addAll` rejects atomically on any single miss.
    await Promise.all(APP_SHELL.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (err) {
        // An optional shell file being absent must never fail the install.
      }
    }));
    await self.skipWaiting(); // activate the new worker immediately
  })());
});

/* --------------------------------------------------------------------------
 *  activate — drop every previous cache generation
 * ------------------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
    );
    await self.clients.claim(); // take control of already-open tabs
  })());
});

/* --------------------------------------------------------------------------
 *  fetch
 * ------------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* 1. Data assets: cache-first. */
  if (isDataAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        // respondWith() requires a real Response — never return undefined.
        // 504 is not `ok`, so the client's loader skips this cell cleanly.
        return new Response('offline: tile not cached', {
          status: 504,
          statusText: 'Gateway Timeout',
          headers: { 'content-type': 'text/plain' },
        });
      }
    })());
    return;
  }

  /* 2. App shell: network-first, fall back to cache when offline. */
  const isSameOrigin = url.origin === self.location.origin;
  const isShell = isSameOrigin &&
    (request.destination === 'document' || request.destination === 'script' || /\.js$/.test(url.pathname));

  if (isShell) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        const hit = await cache.match(request);
        if (hit) return hit;
        return new Response('offline: shell not cached', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
      }
    })());
    return;
  }

  /* 3. Cross-origin (OSM tile servers, unpkg) and everything else: passthrough. */
});
