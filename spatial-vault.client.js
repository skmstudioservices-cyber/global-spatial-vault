/**
 * ============================================================================
 *  spatial-vault.client.js
 *  Browser-side decryption + IndexedDB tile cache for Spatial Vault.
 * ----------------------------------------------------------------------------
 *  Zero dependencies. Works in any modern browser and inside Astro / Leaflet.js
 *  PWAs. It is the exact mirror of the server cipher defined in spatial-vault.js:
 *
 *    - Base64 -> bytes
 *    - XOR rotation-cipher stream keyed by 73 (identical LCG step)
 *    - 10-byte envelope: magic "SVV1" + version + flags + fnv1a32 checksum
 *    - JSON payload (tile / manifest)
 *
 *  It lets the frontend pull static `.dat` files over HTTPS, decrypt them in the
 *  browser, and persist them to IndexedDB for 5-50 km offline use at zero
 *  server cost (the files are just static assets behind a CDN).
 *
 *  ----------------------------------------------------------------------------
 *  USAGE (Astro island or plain script tag)
 *  ----------------------------------------------------------------------------
 *    <script type="module">
 *      import { loadTilesAround, openDB } from '/spatial-vault.client.js';
 *
 *      const db = await openDB('spatial-vault', 'tiles');
 *      const records = await loadTilesAround(db, 12.9716, 77.5946, 25000, {
 *        baseUrl: 'https://cdn.example.com/tiles',   // serves /tiles/t/d/r/1/w/tdr1w.dat
 *        prefixLen: 5,
 *      });
 *      records.forEach((r) => L.marker([r.lat, r.lng]).addTo(map));
 *    </script>
 *
 *  (Non-module fallback: window.SpatialVault.loadTilesAround(...))
 * ============================================================================
 */
(function attach(root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Constants (must match spatial-vault.js exactly)
   * ------------------------------------------------------------------ */
  var CIPHER_KEY = 73;
  var CIPHER_MAGIC = 'SVV1';
  var BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  var MANIFEST_KEY = '__manifest__'; // IndexedDB cache key for the tile manifest

  /* ------------------------------------------------------------------ *
   *  Low-level primitives
   * ------------------------------------------------------------------ */

  /** 32-bit FNV-1a over a Uint8Array (identical to the server version). */
  function fnv1a32(bytes) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  /** Symmetric XOR rotation-cipher stream (same transform both ways). */
  function xorRotate(bytes, key) {
    var out = new Uint8Array(bytes.length);
    var k = (key === undefined ? CIPHER_KEY : key) >>> 0;
    for (var i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] ^ (k & 0xff);
      k = (Math.imul(k, 33) + 17) >>> 0;
    }
    return out;
  }

  /** Decode a standard Base64 string to a Uint8Array. */
  function base64ToBytes(b64) {
    var bin = atob(String(b64));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Encode a Uint8Array to a standard Base64 string (for re-encryption). */
  function bytesToBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /** UTF-8 decode bytes to a string. */
  function bytesToUtf8(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** UTF-8 encode a string to bytes. */
  function utf8ToBytes(str) {
    return new TextEncoder().encode(str);
  }

  /* ------------------------------------------------------------------ *
   *  Decryption (the mirror of encryptJSON)
   * ------------------------------------------------------------------ */

  /**
   * Decrypt a Base64 Spatial Vault asset (tile or manifest) back into its
   * JSON object. Throws on wrong key, bad magic, or checksum mismatch.
   */
  function decrypt(b64, key) {
    if (!b64 || typeof b64 !== 'string') throw new Error('Empty ciphertext');
    var plain = xorRotate(base64ToBytes(b64), key);
    if (plain.length < 10) throw new Error('Ciphertext too short');

    var magic = String.fromCharCode(plain[0], plain[1], plain[2], plain[3]);
    if (magic !== CIPHER_MAGIC) {
      throw new Error('Bad magic: wrong key or not a Spatial Vault asset');
    }
    var version = plain[4];
    if (version !== 1) throw new Error('Unsupported asset version ' + version);
    var expected = ((plain[6] << 24) | (plain[7] << 16) | (plain[8] << 8) | plain[9]) >>> 0;
    var body = plain.slice(10);
    if (fnv1a32(body) !== expected) {
      throw new Error('Checksum mismatch: asset corrupted or tampered');
    }
    return JSON.parse(bytesToUtf8(body));
  }

  /** Symmetric encrypt helper (useful for offline re-exports / tests). */
  function encrypt(obj, key) {
    var body = utf8ToBytes(JSON.stringify(obj));
    var header = new Uint8Array(10);
    header[0] = CIPHER_MAGIC.charCodeAt(0);
    header[1] = CIPHER_MAGIC.charCodeAt(1);
    header[2] = CIPHER_MAGIC.charCodeAt(2);
    header[3] = CIPHER_MAGIC.charCodeAt(3);
    header[4] = 1; // version
    header[5] = 0; // flags
    var checksum = fnv1a32(body);
    header[6] = (checksum >>> 24) & 0xff;
    header[7] = (checksum >>> 16) & 0xff;
    header[8] = (checksum >>> 8) & 0xff;
    header[9] = checksum & 0xff;
    var full = new Uint8Array(10 + body.length);
    full.set(header, 0);
    full.set(body, 10);
    return bytesToBase64(xorRotate(full, key));
  }

  /* ------------------------------------------------------------------ *
   *  Geohash (mirror, used to decide which tiles cover an area)
   * ------------------------------------------------------------------ */

  function encodeGeohash(lat, lng, precision) {
    precision = precision || 13;
    var latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
    var hash = '', bitCount = 0, charIndex = 0, isLng = true;
    while (hash.length < precision) {
      var mid;
      if (isLng) {
        mid = (lngMin + lngMax) / 2;
        if (lng >= mid) { charIndex = (charIndex << 1) | 1; lngMin = mid; }
        else { charIndex <<= 1; lngMax = mid; }
      } else {
        mid = (latMin + latMax) / 2;
        if (lat >= mid) { charIndex = (charIndex << 1) | 1; latMin = mid; }
        else { charIndex <<= 1; latMax = mid; }
      }
      isLng = !isLng;
      bitCount += 1;
      if (bitCount === 5) { hash += BASE32[charIndex]; bitCount = 0; charIndex = 0; }
    }
    return hash;
  }

  /** Approximate cell size (degrees) for a Geohash of `precision` chars. */
  function cellDegrees(precision) {
    var bits = precision * 5;
    var lngBits = Math.ceil(bits / 2);
    var latBits = Math.floor(bits / 2);
    return { latDeg: 180 / Math.pow(2, latBits), lngDeg: 360 / Math.pow(2, lngBits) };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Convert a 5-char prefix to its nested asset path, INCLUDING the top-level
   * `tiles/` folder — identical to the server's `tileRelativeUrl()`:
   *   'tdr1w' -> 'tiles/t/d/r/1/w/tdr1w.dat'
   * `baseUrl` must therefore point at the dist root that CONTAINS `tiles/`.
   */
  function tilePathForPrefix(prefix) {
    return 'tiles/' + prefix.split('').join('/') + '/' + prefix + '.dat';
  }

  /** @deprecated kept as an alias for backward compatibility. */
  function prefixToUrl(prefix) {
    return tilePathForPrefix(prefix);
  }

  /**
   * Return the distinct Geohash prefixes (of length `prefixLen`) whose cells
   * intersect the given bounding box. Sampling uses half-cell steps, which
   * guarantees every intersecting cell is visited.
   */
  function prefixesForBBox(minLat, minLng, maxLat, maxLng, prefixLen) {
    prefixLen = prefixLen || 5;
    var cell = cellDegrees(prefixLen);
    var stepLat = cell.latDeg / 2;
    var stepLng = cell.lngDeg / 2;
    var set = {};
    function add(lat, lng) {
      var la = clamp(lat, -90, 90);
      var lo = lng;
      if (lo > 180) lo -= 360;
      if (lo < -180) lo += 360;
      set[encodeGeohash(la, lo, prefixLen)] = true;
    }
    for (var la = minLat; la <= maxLat + stepLat; la += stepLat) {
      for (var lo = minLng; lo <= maxLng + stepLng; lo += stepLng) {
        add(la, lo);
      }
    }
    // Guarantee corners are included despite float drift.
    add(minLat, minLng);
    add(minLat, maxLng);
    add(maxLat, minLng);
    add(maxLat, maxLng);
    return Object.keys(set);
  }

  /* ------------------------------------------------------------------ *
   *  IndexedDB tile cache
   * ------------------------------------------------------------------ */

  /**
   * Open (creating if needed) an IndexedDB database. Store uses the tile
   * prefix as the key path.
   */
  function openDB(name, store) {
    name = name || 'spatial-vault';
    store = store || 'tiles';
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in root)) return reject(new Error('IndexedDB unavailable'));
      var req = root.indexedDB.open(name, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'prefix' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** Persist a decrypted tile payload under its prefix. */
  function saveTile(db, prefix, payload, store) {
    store = store || 'tiles';
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put({ prefix: prefix, payload: payload, savedAt: Date.now() });
      tx.oncomplete = function () { resolve(prefix); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  /** Read a cached tile payload (null when absent). */
  function getTile(db, prefix, store) {
    store = store || 'tiles';
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, 'readonly');
      var req = tx.objectStore(store).get(prefix);
      req.onsuccess = function () { resolve(req.result ? req.result.payload : null); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** Remove all cached tiles (e.g., version bump). */
  function clearTiles(db, store) {
    store = store || 'tiles';
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  /* ------------------------------------------------------------------ *
   *  Network + offline loader
   * ------------------------------------------------------------------ */

  /**
   * Fetch a single `.dat` asset over HTTPS and decrypt it in the browser.
   */
  async function fetchTile(url, key) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    var text = await res.text();
    return decrypt(text, key);
  }

  /**
   * Fetch + decrypt the master manifest (which lists every tile that actually
   * exists). Cached in IndexedDB under a reserved key.
   */
  async function loadManifest(db, manifestUrl, key, store) {
    var cached = await getTile(db, MANIFEST_KEY, store);
    if (cached) return cached;
    var manifest = await fetchTile(manifestUrl, key);
    await saveTile(db, MANIFEST_KEY, manifest, store);
    return manifest;
  }

  /**
   * Load every tile intersecting a circular area (lat/lng + radius in meters),
   * decrypting on first use and caching to IndexedDB. Returns a flat array of
   * records merged across tiles; later calls in range are served entirely from
   * IndexedDB (offline-capable).
   *
   * A missing tile (HTTP 404 = an empty grid cell) is SKIPPED, never fatal —
   * a radius legitimately spans hundreds of cells while only a few hold data.
   * When the encrypted manifest is reachable it narrows the request set to
   * tiles that exist, so 25-50 km costs a handful of requests, not hundreds.
   *
   * opts: {
   *   baseUrl,        // dist root containing tiles/ and manifest.dat (default '')
   *   prefixLen = 5,
   *   key = 73,
   *   store = 'tiles',
   *   useManifest = true,
   *   manifestUrl,    // defaults to baseUrl + '/manifest.dat'
   *   onProgress,     // optional (loaded, total, prefix)
   * }
   */
  async function loadTilesAround(db, lat, lng, radiusMeters, opts) {
    opts = opts || {};
    var baseUrl = (opts.baseUrl == null ? '' : String(opts.baseUrl)).replace(/\/+$/, '');
    var prefixLen = opts.prefixLen || 5;
    var key = opts.key === undefined ? CIPHER_KEY : opts.key;
    var store = opts.store || 'tiles';
    var manifestUrl = opts.manifestUrl === undefined
      ? baseUrl + '/manifest.dat'
      : opts.manifestUrl;

    var dLat = radiusMeters / 111320;
    var dLng = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));
    var candidates = prefixesForBBox(lat - dLat, lng - dLng, lat + dLat, lng + dLng, prefixLen);

    // Narrow to tiles that exist, via the encrypted manifest (best-effort).
    var available = null;
    if (opts.useManifest !== false && manifestUrl) {
      try {
        var manifest = await loadManifest(db, manifestUrl, key, store);
        if (manifest && manifest.tiles) {
          available = {};
          for (var m = 0; m < manifest.tiles.length; m++) {
            available[manifest.tiles[m].prefix] = true;
          }
        }
      } catch (manifestError) {
        available = null; // manifest is an optimisation, never a requirement
      }
    }

    var records = [];
    for (var i = 0; i < candidates.length; i++) {
      var prefix = candidates[i];
      if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, candidates.length, prefix);

      if (available && !available[prefix]) continue; // known-empty cell

      var payload = await getTile(db, prefix, store);
      if (!payload) {
        try {
          payload = await fetchTile(baseUrl + '/' + tilePathForPrefix(prefix), key);
          await saveTile(db, prefix, payload, store);
        } catch (fetchError) {
          continue; // 404 empty cell or transient miss — skip, never abort
        }
      }
      if (payload && payload.records) {
        records.push.apply(records, payload.records);
      }
    }
    return records;
  }

  /**
   * Load and decrypt EVERY tile listed in the encrypted manifest.
   * Ideal for dashboards, pan-global views and bulk export: one unambiguous
   * request per real tile, with zero 404 probing.
   *
   * Returns { manifest, records }.
   * opts: { baseUrl='', key=73, store='tiles', manifestUrl, onProgress }
   */
  async function loadAllTiles(db, opts) {
    opts = opts || {};
    var baseUrl = (opts.baseUrl == null ? '' : String(opts.baseUrl)).replace(/\/+$/, '');
    var key = opts.key === undefined ? CIPHER_KEY : opts.key;
    var store = opts.store || 'tiles';
    var manifestUrl = opts.manifestUrl === undefined
      ? baseUrl + '/manifest.dat'
      : opts.manifestUrl;

    var manifest = await loadManifest(db, manifestUrl, key, store);
    var tiles = (manifest && manifest.tiles) || [];
    var records = [];

    for (var i = 0; i < tiles.length; i++) {
      var prefix = tiles[i].prefix;
      if (typeof opts.onProgress === 'function') opts.onProgress(i + 1, tiles.length, prefix);

      var payload = await getTile(db, prefix, store);
      if (!payload) {
        payload = await fetchTile(baseUrl + '/' + tilePathForPrefix(prefix), key);
        await saveTile(db, prefix, payload, store);
      }
      if (payload && payload.records) {
        records.push.apply(records, payload.records);
      }
    }
    return { manifest: manifest, records: records };
  }

  /* ------------------------------------------------------------------ *
   *  Exports (ESM + global fallback)
   * ------------------------------------------------------------------ */
  var API = {
    CIPHER_KEY: CIPHER_KEY,
    CIPHER_MAGIC: CIPHER_MAGIC,
    decrypt: decrypt,
    encrypt: encrypt,
    xorRotate: xorRotate,
    fnv1a32: fnv1a32,
    encodeGeohash: encodeGeohash,
    cellDegrees: cellDegrees,
    prefixesForBBox: prefixesForBBox,
    tilePathForPrefix: tilePathForPrefix,
    prefixToUrl: prefixToUrl,
    loadManifest: loadManifest,
    openDB: openDB,
    saveTile: saveTile,
    getTile: getTile,
    clearTiles: clearTiles,
    fetchTile: fetchTile,
    loadTilesAround: loadTilesAround,
    loadAllTiles: loadAllTiles,
  };

  root.SpatialVault = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
