// Runs the app on this PC:  node server.js
//  - with DATABASE_URL in .env  -> uses the same Supabase database as the Netlify site
//  - without it                 -> uses an embedded Postgres stored in data/pg-local (offline copy)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.mjs';
import { ROOT, applySchema, loadLocalData, importInto } from './import-local.mjs';

if (!process.env.IGNORE_ENV_FILE && fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(ROOT, 'public');

let db, where;
if (process.env.DATABASE_URL) {
  db = (await import('./db-pg.mjs')).pgDb(process.env.DATABASE_URL);
  where = 'Supabase (DATABASE_URL)';
} else {
  const dir = process.env.LOCAL_DB_DIR || path.join(ROOT, 'data', 'pg-local');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  db = await (await import('./db-local.mjs')).localDb(dir);
  await applySchema(db);
  const r = await importInto(db, await loadLocalData(process.env.IMPORT_FROM || 'auto'));
  if (r.vehicles || r.users) console.log(`Imported ${r.vehicles} vehicles and ${r.users} logins into the local database`);
  where = `local database (${path.relative(ROOT, dir) || dir})`;
}
const handle = createApp(db);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = '/\u0000'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (req.method !== 'GET' || !file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...STATIC_HEADERS });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...STATIC_HEADERS });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(c); }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined });
    const response = await handle(request, { ip: req.socket.remoteAddress || '' });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Something went wrong on the server"}');
  }
});
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`\nPort ${PORT} is already in use - Yard Stock Tracker is probably already running.`);
  console.error(`Open http://localhost:${PORT}, or close the other copy first.`);
  console.error('To use a different port (PowerShell):  $env:PORT=3001; node server.js');
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Yard Stock Tracker running:  http://localhost:${PORT}`);
  console.log(`Data: ${where}`);
});
