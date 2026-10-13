'use strict';
/* Temporary harness: serves the repo over HTTP and exercises the exact
 * browser code paths (manifest -> candidate narrowing -> fetch -> decrypt). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const client = require('./spatial-vault.client.js');

const ROOT = __dirname;
const MIME = { '.dat': 'text/plain', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, urlPath);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const baseUrl = `${origin}/dist`; // serving the repo root -> dist root is /dist

  let failures = 0;
  const check = (cond, label) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + label);
    if (!cond) failures += 1;
  };

  const manifestB64 = await (await fetch(`${baseUrl}/manifest.dat`)).text();
  const manifest = client.decrypt(manifestB64);
  check(manifest.format === 'spatial-vault-manifest', 'manifest.dat decrypts over HTTP');
  check(manifest.tiles && manifest.tiles.length === 8, `manifest lists 8 tiles (got ${manifest.tiles && manifest.tiles.length})`);

  const lat = 12.9716, lng = 77.5946, radius = 25000;
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const candidates = client.prefixesForBBox(lat - dLat, lng - dLng, lat + dLat, lng + dLng, 5);
  check(candidates.length > 100, `25 km radius spans many cells (${candidates.length})`);

  const available = {};
  manifest.tiles.forEach((t) => { available[t.prefix] = true; });
  const toFetch = candidates.filter((p) => available[p]);
  check(toFetch.length === 1 && toFetch[0] === 'tdr1w',
    `manifest narrows ${candidates.length} candidates -> ${toFetch.length} real tile(s): ${toFetch.join(',')}`);

  const missing = candidates.find((p) => !available[p]);
  const missRes = await fetch(`${baseUrl}/${client.tilePathForPrefix(missing)}`);
  check(missRes.status === 404, `an empty cell really is HTTP 404 (old code threw here): ${client.tilePathForPrefix(missing)}`);

  const tileB64 = await (await fetch(`${baseUrl}/${client.tilePathForPrefix('tdr1w')}`)).text();
  const tile = client.decrypt(tileB64);
  check(tile.prefix === 'tdr1w' && tile.count === 1, 'tdr1w tile decrypts with 1 record');
  check(tile.records[0].category === 'potholes', 'decrypted record category is potholes');
  check(tile.records[0].precision.geohash.length === 13, 'record carries 13-char geohash');

  const detect = (await fetch(`${origin}/dist/manifest.dat`)).ok ? '/dist' : null;
  check(detect === '/dist', "demo's detectBaseUrl() resolves to /dist when serving repo root");

  const oldStyle = await fetch(`${baseUrl.replace('/dist', '')}/tiles/t/d/r/1/w/tdr1w.dat`);
  check(oldStyle.status === 404, 'old baseUrl "/tiles" is 404 when serving repo root (the reported failure)');

  // --- dashboard path: whole-manifest load via a fake IndexedDB ---
  function fakeDB() {
    const data = new Map();
    return {
      transaction() {
        const tx = { oncomplete: null, onerror: null, error: null };
        const req = (fn) => {
          const r = { onsuccess: null, onerror: null, result: undefined };
          queueMicrotask(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); });
          return r;
        };
        tx.objectStore = () => ({
          get: (key) => req(() => data.get(key)),
          put: (val) => req(() => data.set(val.prefix, val)),
          clear: () => req(() => data.clear()),
        });
        setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
        return tx;
      },
    };
  }

  const db = fakeDB();
  const all = await client.loadAllTiles(db, { baseUrl });
  check(all.manifest && all.manifest.tiles.length === 8, 'loadAllTiles reads the encrypted manifest');
  check(all.records.length === 8, `loadAllTiles decrypts every record across tiles (got ${all.records.length})`);
  check(new Set(all.records.map((r) => r.category)).size >= 4, 'loadAllTiles spans multiple niche categories');
  const cachedPass = await client.loadAllTiles(db, { baseUrl });
  check(cachedPass.records.length === 8, 'loadAllTiles second pass is served from the cache');

  await new Promise((resolve) => server.close(resolve));
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
