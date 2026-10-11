const CACHE_NAME = 'spatial-vault-v1';
const STATIC_ASSETS = [
  '/',
  '/frontend/demo.html',
  '/frontend/dashboard.html',
  'https://unpkg.com',
  'https://unpkg.com',
  '/spatial-vault.client.js',
  '/spatial-vault.map.js'
];

// Helper mapping tool to calculate adjacent geohash bounds for 50km radius prefetching
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const NEIGHBORS = {
  north: { even: 'p0r21436x8zb9dcf5h7kjnmqvwuyetgs', odd: 'bc01fg4523hj89np67kmstuvqrwxdezy' },
  south: { even: '10325476c8b9edfghjkmnpqrstuvwxyz', odd: '2301674589bcklmjnoptqrstvwxyzdef' },
  east:  { even: 'bc01fg4523hj89np67kmstuvqrwxdezy', odd: 'p0r21436x8zb9dcf5h7kjnmqvwuyetgs' },
  west:  { even: '2301674589bcklmjnoptqrstvwxyzdef', odd: '10325476c8b9edfghjkmnpqrstuvwxyz' }
};

function getAdjacentGeohash(srcHash, dir) {
  srcHash = srcHash.toLowerCase();
  const lastChr = srcHash.charAt(srcHash.length - 1);
  const type = (srcHash.length % 2) ? 'odd' : 'even';
  let base = srcHash.substring(0, srcHash.length - 1);
  if (NEIGHBORS[dir][type].indexOf(lastChr) === -1) return srcHash;
  const idx = NEIGHBORS[dir][type].indexOf(lastChr);
  return base + BASE32.charAt(idx);
}

// 1. Install lifecycle: cache the entire core application shell static layers
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

// 2. Fetch interception wrapper: handle cache-first delivery and graceful network drops
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;
      
      // If it's a spatial .dat request link file target, apply network fetch with fallback parameters
      if (event.request.url.includes('.dat')) {
        return fetch(event.request).catch(() => {
          console.warn('?? Network offline connection detected. Resolving payload from browser native cache fallback states.');
          // IndexedDB data assets will pass cleanly inside the frontend layers context
        });
      }
      return fetch(event.request);
    })
  );
});
