'use strict';
// Yard Stock Tracker - single-file server. No npm packages needed (Node 22.13+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// LEGACY: the original single-PC version that stores data in data/yard.db (SQLite).
// Replaced by src/app.mjs (Postgres / Supabase). Kept only as a fallback: node legacy/server-sqlite.js
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'yard.db');
const SEED_PATH = process.env.SEED_PATH || path.join(ROOT, 'data', 'seed.json');
const SESSION_HOURS = 12;

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = DELETE;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','handler','customer')),
  customer_name TEXT COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  customer_name TEXT COLLATE NOCASE,
  vin TEXT NOT NULL UNIQUE COLLATE NOCASE,
  five_digit TEXT,
  make TEXT,
  model TEXT,
  color TEXT,
  yard TEXT,
  bl TEXT,
  in_date TEXT,
  out_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_name);
CREATE INDEX IF NOT EXISTS idx_vehicles_in ON vehicles(in_date);
CREATE INDEX IF NOT EXISTS idx_vehicles_five ON vehicles(five_digit);
`);

const FIELDS = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date'];
const LABELS = { customer_name: 'Customer Name', vin: 'VIN', five_digit: '5 Digit', make: 'Make', model: 'Model', color: 'Color', yard: 'Yard', bl: 'BL', in_date: 'IN date', out_date: 'OUT date' };
const REQUIRED = ['vin', 'five_digit', 'make', 'model', 'yard', 'in_date'];
const UPPER = new Set(['vin', 'five_digit', 'make', 'color', 'yard', 'bl']);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------- helpers
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Returns ISO date, null when empty, undefined when unreadable.
// Slashed dates are read as day/month/year unless that is impossible.
function parseDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) return isoDate(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/))) {
    const a = Number(m[1]), b = Number(m[2]);
    return a > 12 || b <= 12 ? isoDate(m[3], b, a) : isoDate(m[3], a, b);
  }
  if ((m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*[\s\-\/,]+(\d{2}|\d{4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? isoDate(m[3], mo, m[1]) : undefined;
  }
  return undefined;
}

function cleanText(field, v) {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
  if (UPPER.has(field)) s = s.toUpperCase();
  return s;
}

// Normalises an incoming record. Returns { rec, errors }.
function normalise(input, old) {
  const rec = {}, errors = [];
  for (const f of FIELDS) {
    if (!(f in input)) continue;
    if (f === 'in_date' || f === 'out_date') {
      const d = parseDate(input[f]);
      if (d === undefined) errors.push(`${LABELS[f]} "${String(input[f]).slice(0, 30)}" is not a valid date`);
      else rec[f] = d;
    } else rec[f] = cleanText(f, input[f]);
  }
  if (rec.vin !== undefined && rec.vin && !/^[A-Z0-9]{5,20}$/.test(rec.vin)) errors.push('VIN must be 5-20 letters/digits with no spaces');
  // old Excel rows that already hold a 6-character value may keep it
  if (rec.five_digit && rec.five_digit !== (old && old.five_digit) && !/^[A-Z0-9]{5}$/.test(rec.five_digit)) errors.push('5 Digit must be exactly 5 letters/digits');
  return { rec, errors };
}

function checkRequired(rec, fields) {
  return fields.filter(f => !rec[f]).map(f => `${LABELS[f]} is required`);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUser(body, { needPassword }) {
  const errors = [];
  const u = {
    name: cleanText('name', body.name),
    email: String(body.email || '').trim().toLowerCase().slice(0, 200),
    role: String(body.role || ''),
    customer_name: cleanText('customer_name', body.customer_name),
    password: body.password === undefined || body.password === null ? '' : String(body.password),
  };
  if (!u.name) errors.push('Name is required');
  if (!EMAIL_RE.test(u.email)) errors.push('A valid email is required');
  if (!['admin', 'handler', 'customer'].includes(u.role)) errors.push('Role must be admin, handler or customer');
  if (u.role === 'customer' && !u.customer_name) errors.push('Customer Name is required for a customer login');
  if (u.role !== 'customer') u.customer_name = '';
  if ((needPassword || u.password) && u.password.length < 8) errors.push('Password must be at least 8 characters');
  return { u, errors };
}

// ---------------------------------------------------------------- seed (first run only)
(function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM vehicles').get().n > 0 || !fs.existsSync(SEED_PATH)) return;
  const rows = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const ins = db.prepare(`INSERT OR IGNORE INTO vehicles (${FIELDS.join(',')}, updated_by) VALUES (${FIELDS.map(() => '?').join(',')}, 'Excel import')`);
  let n = 0;
  tx(() => {
    for (const row of rows) {
      const { rec } = normalise(row);
      if (!rec.vin) continue;
      n += Number(ins.run(...FIELDS.map(f => rec[f] || null)).changes);
    }
  });
  console.log(`Imported ${n} vehicles from ${path.basename(SEED_PATH)}`);
})();

// ---------------------------------------------------------------- http plumbing
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Expected JSON'));
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(b && typeof b === 'object' ? b : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.customer_name, s.expires
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(sid));
  if (!row || row.expires < Date.now()) return null;
  delete row.expires;
  return row;
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?,?,?)').run(sha256(token), userId, Date.now() + SESSION_HOURS * 3600e3);
  return { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}` };
}
function need(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please sign in');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Your role is not allowed to do this');
}

// login throttling: 8 failed attempts per IP+email -> 10 minute lock
const fails = new Map();
function throttleKey(req, email) { return `${req.socket.remoteAddress}|${email}`; }
function checkThrottle(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
}
function noteFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 8) { f.until = Date.now() + 10 * 60e3; f.n = 0; }
  fails.set(key, f);
}

// ---------------------------------------------------------------- filters
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGE_BUCKETS = { '0-7 days': [-99999, 7], '8-15 days': [8, 15], '16-30 days': [16, 30], '31-60 days': [31, 60], 'Over 60 days': [61, 9999999] };
// skip: filters to leave out (make/model/yard/color/age/in/out). A chart leaves out its own
// filter so it can still draw the segments that are not selected.
function buildWhere(q, user, skip = []) {
  const w = [], p = [];
  if (user.role === 'customer') { w.push('customer_name = ?'); p.push(user.customer_name || '\u0000'); }
  // every list filter may be given several times (?make=A&make=B) = any of those values
  const multi = k => q.getAll(k).filter(Boolean).slice(0, 300);
  const marks = list => list.map(() => '?').join(',');
  if (user.role !== 'customer') {
    const cs = multi('customer');
    if (cs.length) { w.push(`customer_name IN (${marks(cs)})`); p.push(...cs); }
  }
  for (const col of ['make', 'model', 'yard', 'color']) {
    const vs = skip.includes(col) ? [] : multi(col);
    if (!vs.length) continue;
    const named = vs.filter(v => v !== '(Blank)'), parts = [];
    if (named.length) { parts.push(`${col} IN (${marks(named)})`); p.push(...named); }
    if (named.length < vs.length) parts.push(`${col} IS NULL OR ${col} = ''`);
    w.push(`(${parts.join(' OR ')})`);
  }
  const st = new Set(multi('status'));
  if (st.has('in') && !st.has('out')) w.push('out_date IS NULL');
  if (st.has('out') && !st.has('in')) w.push('out_date IS NOT NULL');
  for (const k of ['in', 'out']) {
    if (skip.includes(k)) continue;
    if (ISO_RE.test(q.get(k + '_from') || '')) { w.push(`${k}_date >= ?`); p.push(q.get(k + '_from')); }
    if (ISO_RE.test(q.get(k + '_to') || '')) { w.push(`${k}_date <= ?`); p.push(q.get(k + '_to')); }
  }
  const ages = skip.includes('age') ? [] : multi('age').filter(a => AGE_BUCKETS[a]);
  if (ages.length) {
    w.push(`(out_date IS NULL AND in_date IS NOT NULL AND (${ages.map(() => `${DAYS_SQL} BETWEEN ? AND ?`).join(' OR ')}))`);
    ages.forEach(a => p.push(...AGE_BUCKETS[a]));
  }
  if (q.get('missing') === '1') w.push("(model IS NULL OR model = '' OR color IS NULL OR color = '')");
  const s = (q.get('q') || '').trim().slice(0, 60);
  if (s) {
    const like = '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';
    w.push("(vin LIKE ? ESCAPE '\\' OR five_digit LIKE ? ESCAPE '\\' OR bl LIKE ? ESCAPE '\\')");
    p.push(like, like, like);
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}
const DAYS_SQL = "CAST(julianday(COALESCE(out_date, date('now','localtime'))) - julianday(in_date) AS INTEGER)";
const SORTS = { customer_name: 'customer_name', vin: 'vin', five_digit: 'five_digit', make: 'make', model: 'model', color: 'color', yard: 'yard', bl: 'bl', in_date: 'in_date', out_date: 'out_date', days: DAYS_SQL };

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------- api
async function api(req, res, url) {
  const p = url.pathname, m = req.method, q = url.searchParams;
  const user = currentUser(req);
  const userCount = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;

  if (p === '/api/me' && m === 'GET') return send(res, 200, { user, needsSetup: userCount() === 0 });

  if (p === '/api/setup' && m === 'POST') {
    if (userCount() > 0) throw new HttpError(403, 'Setup is already complete');
    const { u, errors } = validateUser({ ...(await readJson(req)), role: 'admin' }, { needPassword: true });
    if (errors.length) throw new HttpError(400, errors.join('. '));
    const salt = crypto.randomBytes(16).toString('hex');
    const r = db.prepare('INSERT INTO users (name,email,pass_hash,salt,role) VALUES (?,?,?,?,?)').run(u.name, u.email, hashPassword(u.password, salt), salt, 'admin');
    return send(res, 200, { ok: true }, startSession(res, Number(r.lastInsertRowid)));
  }

  if (p === '/api/login' && m === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const key = throttleKey(req, email);
    checkThrottle(key);
    const row = db.prepare('SELECT id, pass_hash, salt FROM users WHERE email = ?').get(email);
    const given = hashPassword(body.password || '', row ? row.salt : 'x'.repeat(32));
    const ok = row && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(row.pass_hash, 'hex'));
    if (!ok) { noteFail(key); throw new HttpError(401, 'Email or password is incorrect'); }
    fails.delete(key);
    return send(res, 200, { ok: true }, startSession(res, row.id));
  }

  if (p === '/api/logout' && m === 'POST') {
    const sid = cookies(req).sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  need(user);

  // ---- filter option lists (scoped to what the user may see)
  if (p === '/api/options' && m === 'GET') {
    const scope = user.role === 'customer' ? { sql: 'WHERE customer_name = ?', p: [user.customer_name || '\u0000'] } : { sql: '', p: [] };
    const list = col => db.prepare(`SELECT DISTINCT ${col} v FROM vehicles ${scope.sql} ${scope.sql ? 'AND' : 'WHERE'} ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`).all(...scope.p).map(r => r.v);
    return send(res, 200, {
      customers: user.role === 'customer' ? [user.customer_name] : list('customer_name'),
      makes: list('make'), yards: list('yard'), colors: list('color'),
      models: db.prepare(`SELECT DISTINCT make, model FROM vehicles ${scope.sql} ${scope.sql ? 'AND' : 'WHERE'} model IS NOT NULL AND model <> '' ORDER BY model`).all(...scope.p),
    });
  }

  // ---- dashboard numbers
  if (p === '/api/stats' && m === 'GET') {
    const f = buildWhere(q, user);
    // each chart ignores its own filter, so a clicked segment stays in context with the others
    const scoped = (skip, cond) => { const g = buildWhere(q, user, skip); return { sql: `${g.sql ? g.sql + ' AND' : 'WHERE'} ${cond}`, p: g.p }; };
    const group = col => { const g = buildWhere(q, user, [col]); return db.prepare(`SELECT COALESCE(NULLIF(${col},''),'(Blank)') name, COUNT(*) value FROM vehicles ${g.sql} GROUP BY 1 ORDER BY value DESC, name`).all(...g.p); };
    const ag = scoped(['age'], 'out_date IS NULL AND in_date IS NOT NULL'), di = scoped(['in'], 'in_date IS NOT NULL'), dout = scoped(['out'], 'out_date IS NOT NULL');
    const totals = db.prepare(`SELECT COUNT(*) total,
        SUM(out_date IS NULL) in_yard, SUM(out_date IS NOT NULL) moved_out,
        AVG(CASE WHEN out_date IS NULL THEN ${DAYS_SQL} END) avg_days_in_yard,
        AVG(CASE WHEN out_date IS NOT NULL THEN ${DAYS_SQL} END) avg_days_to_exit,
        MAX(CASE WHEN out_date IS NULL THEN ${DAYS_SQL} END) oldest_days,
        SUM(model IS NULL OR model = '' OR color IS NULL OR color = '') missing
      FROM vehicles ${f.sql}`).get(...f.p);
    const ageing = db.prepare(`SELECT bucket name, COUNT(*) value FROM (
        SELECT CASE WHEN d <= 7 THEN '0-7 days' WHEN d <= 15 THEN '8-15 days' WHEN d <= 30 THEN '16-30 days'
                    WHEN d <= 60 THEN '31-60 days' ELSE 'Over 60 days' END bucket
        FROM (SELECT ${DAYS_SQL} d FROM vehicles ${ag.sql})) GROUP BY 1`).all(...ag.p);
    return send(res, 200, {
      totals, ageing,
      byMake: group('make'), byModel: group('model'), byYard: group('yard'), byColor: group('color'),
      dailyIn: db.prepare(`SELECT in_date d, COUNT(*) n FROM vehicles ${di.sql} GROUP BY 1 ORDER BY 1`).all(...di.p),
      dailyOut: db.prepare(`SELECT out_date d, COUNT(*) n FROM vehicles ${dout.sql} GROUP BY 1 ORDER BY 1`).all(...dout.p),
    });
  }

  // ---- records list
  if (p === '/api/vehicles' && m === 'GET') {
    const f = buildWhere(q, user);
    const size = Math.min(Math.max(parseInt(q.get('size'), 10) || 50, 1), 200);
    const page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
    const sort = SORTS[q.get('sort')] || 'in_date';
    const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM vehicles ${f.sql}`).get(...f.p).n;
    const rows = db.prepare(`SELECT id, ${FIELDS.join(', ')}, ${DAYS_SQL} days, updated_at, updated_by
      FROM vehicles ${f.sql} ORDER BY ${sort} ${dir}, id DESC LIMIT ? OFFSET ?`).all(...f.p, size, (page - 1) * size);
    return send(res, 200, { total, page, size, rows });
  }

  if (p === '/api/export.csv' && m === 'GET') {
    const f = buildWhere(q, user);
    const rows = db.prepare(`SELECT ${FIELDS.join(', ')}, ${DAYS_SQL} days FROM vehicles ${f.sql} ORDER BY in_date DESC, id DESC`).all(...f.p);
    const head = [...FIELDS.map(k => LABELS[k]), 'Days in yard'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) lines.push([...FIELDS.map(k => r[k]), r.days].map(csvCell).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="yard-stock-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
    return res.end('﻿' + lines.join('\r\n'));
  }

  // ---- add a record (admin, handler)
  if (p === '/api/vehicles' && m === 'POST') {
    need(user, 'admin', 'handler');
    const { rec, errors } = normalise(await readJson(req));
    errors.push(...checkRequired(rec, REQUIRED));
    if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errors.push('OUT date cannot be before IN date');
    if (errors.length) throw new HttpError(400, errors.join('. '));
    if (db.prepare('SELECT 1 FROM vehicles WHERE vin = ?').get(rec.vin)) throw new HttpError(409, `VIN ${rec.vin} already exists - update that record instead`);
    const r = db.prepare(`INSERT INTO vehicles (${FIELDS.join(',')}, updated_by) VALUES (${FIELDS.map(() => '?').join(',')}, ?)`).run(...FIELDS.map(k => rec[k] || null), user.name);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }

  // ---- bulk add / update, matched on VIN (admin, handler)
  if (p === '/api/vehicles/import' && m === 'POST') {
    need(user, 'admin', 'handler');
    const body = await readJson(req);
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];
    const dryRun = body.dryRun !== false;
    const out = { created: 0, updated: 0, unchanged: 0, errors: [], dryRun };
    const find = db.prepare(`SELECT id, ${FIELDS.join(', ')} FROM vehicles WHERE vin = ?`);
    const ins = db.prepare(`INSERT INTO vehicles (${FIELDS.join(',')}, updated_by) VALUES (${FIELDS.map(() => '?').join(',')}, ?)`);
    const seen = new Set();
    tx(() => {
      rows.forEach((row, i) => {
        const fail = msg => out.errors.push({ row: i + 1, vin: cleanText('vin', row && row.vin), message: msg });
        if (!row || typeof row !== 'object') return fail('Unreadable row');
        const vinKey = cleanText('vin', row.vin);
        const { rec, errors } = normalise(row, vinKey ? find.get(vinKey) : undefined);
        if (!rec.vin) errors.unshift('VIN is required');
        if (errors.length) return fail(errors.join('. '));
        if (seen.has(rec.vin)) return fail('VIN appears more than once in this paste');
        seen.add(rec.vin);
        const old = find.get(rec.vin);
        if (!old) {
          if (!rec.five_digit) rec.five_digit = rec.vin.slice(-5);
          const errs = checkRequired(rec, REQUIRED);
          if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errs.push('OUT date cannot be before IN date');
          if (errs.length) return fail('New VIN: ' + errs.join('. '));
          if (!dryRun) ins.run(...FIELDS.map(k => rec[k] || null), user.name);
          return void out.created++;
        }
        // existing VIN: only non-empty pasted cells overwrite
        const changes = {};
        for (const k of FIELDS) if (k !== 'vin' && rec[k] && rec[k] !== (old[k] || '')) changes[k] = rec[k];
        const merged = { ...old, ...changes };
        if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) return fail('OUT date cannot be before IN date');
        const keys = Object.keys(changes);
        if (!keys.length) return void out.unchanged++;
        if (!dryRun) db.prepare(`UPDATE vehicles SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ?`).run(...keys.map(k => changes[k]), user.name, old.id);
        out.updated++;
      });
    });
    out.errors = out.errors.slice(0, 200);
    return send(res, 200, out);
  }

  let mm;
  if ((mm = p.match(/^\/api\/vehicles\/(\d+)$/))) {
    const id = Number(mm[1]);
    const old = db.prepare(`SELECT id, ${FIELDS.join(', ')} FROM vehicles WHERE id = ?`).get(id);
    if (m === 'PUT') {
      need(user, 'admin', 'handler');
      if (!old) throw new HttpError(404, 'Record not found');
      const { rec, errors } = normalise(await readJson(req), old);
      const merged = { ...old, ...rec };
      // a mandatory field may not be left empty (old Excel rows with a blank model can stay blank)
      errors.push(...checkRequired(merged, REQUIRED.filter(k => old[k] || k !== 'model')));
      if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) errors.push('OUT date cannot be before IN date');
      if (errors.length) throw new HttpError(400, errors.join('. '));
      if (merged.vin !== old.vin && db.prepare('SELECT 1 FROM vehicles WHERE vin = ? AND id <> ?').get(merged.vin, id)) throw new HttpError(409, `VIN ${merged.vin} already exists`);
      db.prepare(`UPDATE vehicles SET ${FIELDS.map(k => k + ' = ?').join(', ')}, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ?`).run(...FIELDS.map(k => merged[k] || null), user.name, id);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      need(user, 'admin');
      if (!old) throw new HttpError(404, 'Record not found');
      db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  // ---- user management (admin)
  if (p === '/api/users' && m === 'GET') {
    need(user, 'admin');
    return send(res, 200, { users: db.prepare('SELECT id, name, email, role, customer_name, created_at FROM users ORDER BY role, name').all() });
  }
  if (p === '/api/users' && m === 'POST') {
    need(user, 'admin');
    const { u, errors } = validateUser(await readJson(req), { needPassword: true });
    if (errors.length) throw new HttpError(400, errors.join('. '));
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) throw new HttpError(409, 'That email already has a login');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (name,email,pass_hash,salt,role,customer_name) VALUES (?,?,?,?,?,?)').run(u.name, u.email, hashPassword(u.password, salt), salt, u.role, u.customer_name || null);
    return send(res, 201, { ok: true });
  }
  if ((mm = p.match(/^\/api\/users\/(\d+)$/))) {
    need(user, 'admin');
    const id = Number(mm[1]);
    const old = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!old) throw new HttpError(404, 'User not found');
    const lastAdmin = old.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n === 1;
    if (m === 'PUT') {
      const { u, errors } = validateUser(await readJson(req), { needPassword: false });
      if (lastAdmin && u.role !== 'admin') errors.push('This is the only admin - create another admin first');
      if (errors.length) throw new HttpError(400, errors.join('. '));
      if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(u.email, id)) throw new HttpError(409, 'That email already has a login');
      db.prepare('UPDATE users SET name = ?, email = ?, role = ?, customer_name = ? WHERE id = ?').run(u.name, u.email, u.role, u.customer_name || null, id);
      if (u.password) {
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(u.password, salt), salt, id);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?').run(id, user.id);
      }
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      if (id === user.id) throw new HttpError(400, 'You cannot delete your own login');
      if (lastAdmin) throw new HttpError(400, 'This is the only admin');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}

// ---------------------------------------------------------------- server
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...SEC_HEADERS });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, url);
    else throw new HttpError(405, 'Method not allowed');
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server' });
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
  console.log('Other PCs on the same network can use  http://<this-PC-IP>:' + PORT);
});
