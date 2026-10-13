'use strict';
/**
 * dev-server.js — zero-dependency static server for the Spatial Vault demo.
 *
 * Serves the repository root so the demo and the generated assets resolve the
 * way they do in production:
 *
 *   http://localhost:3000/frontend/demo.html     <- the map demo
 *   http://localhost:3000/spatial-vault.client.js
 *   http://localhost:3000/dist/tiles/t/d/r/1/w/tdr1w.dat
 *   http://localhost:3000/dist/manifest.dat
 *
 * Usage:  node dev-server.js        (PORT=3000 by default)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.dat': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, urlPath);

  // Never escape the served root.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('403 forbidden');
  }

  fs.stat(file, (statErr, stat) => {
    const target = !statErr && stat.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('404 not found: ' + urlPath);
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Spatial Vault dev server listening on http://localhost:${PORT}`);
  console.log(`Demo:      http://localhost:${PORT}/frontend/demo.html`);
  console.log(`Manifest:  http://localhost:${PORT}/dist/manifest.dat`);
  console.log('Press Ctrl+C to stop.');
});
