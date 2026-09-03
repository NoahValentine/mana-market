// Tiny static server for local dev + tests. Supports byte ranges (series.bin
// needs them) and the same content types Cloudflare Pages serves.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8787);
// GitHub Pages serves a project site under /<repo>/. Set BASE_PATH to mimic it.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"worker not running in dev"}');
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (BASE_PATH) {
    if (rel === BASE_PATH) { res.writeHead(302, { Location: `${BASE_PATH}/` }); res.end(); return; }
    if (!rel.startsWith(`${BASE_PATH}/`)) { res.writeHead(404); res.end('Not found'); return; }
    rel = rel.slice(BASE_PATH.length);
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const fallback = path.join(ROOT, 'index.html');
    const body = fs.readFileSync(fallback);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Length': body.length });
    res.end(body);
    return;
  }
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${Math.min(end, stat.size - 1)}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': Math.min(end, stat.size - 1) - start + 1,
    });
    fs.createReadStream(file, { start, end: Math.min(end, stat.size - 1) }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log(`mana-market dev server on http://localhost:${PORT}`));
