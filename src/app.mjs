// Yard Stock Tracker - the whole API, written against web-standard Request/Response so the
// same code runs as a Netlify Function (production) and under server.js (this PC).
// `db` is { query(sql, params) -> rows, tx(fn) } speaking Postgres with ? placeholders.
import crypto from 'node:crypto';

const SESSION_HOURS = 12;
export const FIELDS = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date'];
const LABELS = { customer_name: 'Customer Name', vin: 'VIN', five_digit: '5 Digit', make: 'Make', model: 'Model', color: 'Color', yard: 'Yard', bl: 'BL', in_date: 'IN date', out_date: 'OUT date' };
const REQUIRED = ['vin', 'five_digit', 'make', 'model', 'yard', 'in_date'];
const UPPER = new Set(['vin', 'five_digit', 'make', 'color', 'yard', 'bl']);

// "today" for days-in-yard is the yard's local date, not the database server's
const TZ = /^[A-Za-z0-9_+\-/]+$/.test(process.env.APP_TZ || '') ? process.env.APP_TZ : 'Asia/Dubai';
const TODAY_SQL = `(now() AT TIME ZONE '${TZ}')::date`;
const DAYS_SQL = `(COALESCE(out_date, ${TODAY_SQL}) - in_date)`;
// dates always travel as YYYY-MM-DD text
const ROW_SQL = `id, customer_name, vin, five_digit, make, model, color, yard, bl, in_date::text AS in_date, out_date::text AS out_date`;
const RECORDSET = `(id integer, customer_name text, vin text, five_digit text, make text, model text, color text, yard text, bl text, in_date date, out_date date)`;

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
export function normalise(input, old) {
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
const checkRequired = (rec, fields) => fields.filter(f => !rec[f]).map(f => `${LABELS[f]} is required`);
const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGE_BUCKETS = { '0-7 days': [-99999, 7], '8-15 days': [8, 15], '16-30 days': [16, 30], '31-60 days': [31, 60], 'Over 60 days': [61, 9999999] };

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

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Bulk writes send all rows as one JSON parameter, so thousands of rows cost a few statements.
const INSERT_COLS = FIELDS.join(', ');
export async function insertVehicles(q, rows, by) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000).map(r => Object.fromEntries(FIELDS.map(k => [k, r[k] || null])));
    const res = await q(`INSERT INTO vehicles (${INSERT_COLS}, updated_by)
      SELECT ${FIELDS.map(k => 'x.' + k).join(', ')}, ?::text FROM jsonb_to_recordset(?::jsonb) AS x${RECORDSET}
      ON CONFLICT (vin) DO NOTHING RETURNING id`, [by, JSON.stringify(chunk)]);
    n += res.length;
  }
  return n;
}
async function updateVehicles(q, rows, by) {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000).map(r => ({ id: r.id, ...Object.fromEntries(FIELDS.map(k => [k, r[k] || null])) }));
    await q(`UPDATE vehicles v SET ${FIELDS.map(k => `${k} = x.${k}`).join(', ')}, updated_at = now(), updated_by = ?::text
      FROM jsonb_to_recordset(?::jsonb) AS x${RECORDSET} WHERE v.id = x.id`, [by, JSON.stringify(chunk)]);
  }
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...headers } });

// ---------------------------------------------------------------- filters
// skip: filters to leave out (make/model/yard/color/age/in/out). A chart leaves out its own
// filter so it can still draw the segments that are not selected.
function buildWhere(q, user, skip = []) {
  const w = [], p = [];
  const multi = k => q.getAll(k).filter(Boolean).slice(0, 300);
  const marks = list => list.map(() => '?').join(',');
  if (user.role === 'customer') { w.push('lower(customer_name) = ?'); p.push((user.customer_name || '\u0001').toLowerCase()); }
  else {
    const cs = multi('customer');
    if (cs.length) { w.push(`lower(customer_name) IN (${marks(cs)})`); p.push(...cs.map(c => c.toLowerCase())); }
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
    if (ISO_RE.test(q.get(k + '_from') || '')) { w.push(`${k}_date >= ?::date`); p.push(q.get(k + '_from')); }
    if (ISO_RE.test(q.get(k + '_to') || '')) { w.push(`${k}_date <= ?::date`); p.push(q.get(k + '_to')); }
  }
  const ages = skip.includes('age') ? [] : multi('age').filter(a => AGE_BUCKETS[a]);
  if (ages.length) {
    w.push(`(out_date IS NULL AND in_date IS NOT NULL AND (${ages.map(() => `${DAYS_SQL} BETWEEN ?::int AND ?::int`).join(' OR ')}))`);
    ages.forEach(a => p.push(...AGE_BUCKETS[a]));
  }
  if (q.get('missing') === '1') w.push("(COALESCE(model, '') = '' OR COALESCE(color, '') = '')");
  const s = (q.get('q') || '').trim().slice(0, 60);
  if (s) {
    const like = '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';
    w.push("(vin ILIKE ? ESCAPE '\\' OR five_digit ILIKE ? ESCAPE '\\' OR bl ILIKE ? ESCAPE '\\')");
    p.push(like, like, like);
  }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}
const SORTS = { customer_name: 'customer_name', vin: 'vin', five_digit: 'five_digit', make: 'make', model: 'model', color: 'color', yard: 'yard', bl: 'bl', in_date: 'in_date', out_date: 'out_date', days: DAYS_SQL };

// ---------------------------------------------------------------- app
export function createApp(db) {
  const one = async (sql, params) => (await db.query(sql, params))[0];
  const count = async (sql, params) => (await one(sql, params)).n;

  function cookies(request) {
    const out = {};
    for (const part of (request.headers.get('cookie') || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
    }
    return out;
  }
  async function readJson(request) {
    if (!/^application\/json/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Expected JSON');
    if (Number(request.headers.get('content-length') || 0) > 5.5 * 1024 * 1024) throw new HttpError(413, 'Request too large - paste fewer rows at a time');
    try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; }
    catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  async function currentUser(request) {
    const sid = cookies(request).sid;
    if (!sid) return null;
    return (await one(`SELECT u.id, u.name, u.email, u.role, u.customer_name FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires > ?`, [sha256(sid), Date.now()])) || null;
  }
  const cookieFlags = url => `HttpOnly; SameSite=Lax; Path=/${url.protocol === 'https:' ? '; Secure' : ''}`;
  async function startSession(userId, url) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('DELETE FROM sessions WHERE expires < ?', [Date.now()]);
    await db.query('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?,?,?)', [sha256(token), userId, Date.now() + SESSION_HOURS * 3600e3]);
    return { 'Set-Cookie': `sid=${token}; ${cookieFlags(url)}; Max-Age=${SESSION_HOURS * 3600}` };
  }
  function need(user, ...roles) {
    if (!user) throw new HttpError(401, 'Please sign in');
    if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Your role is not allowed to do this');
  }

  async function api(request, url, ip) {
    const p = url.pathname, m = request.method, q = url.searchParams;
    const user = await currentUser(request);
    const userCount = () => count('SELECT COUNT(*)::int n FROM users');

    if (p === '/api/me' && m === 'GET') return json(200, { user, needsSetup: (await userCount()) === 0 });

    if (p === '/api/setup' && m === 'POST') {
      if ((await userCount()) > 0) throw new HttpError(403, 'Setup is already complete');
      const { u, errors } = validateUser({ ...(await readJson(request)), role: 'admin' }, { needPassword: true });
      if (errors.length) throw new HttpError(400, errors.join('. '));
      const salt = crypto.randomBytes(16).toString('hex');
      const r = await one('INSERT INTO users (name,email,pass_hash,salt,role) VALUES (?,?,?,?,?) RETURNING id', [u.name, u.email, hashPassword(u.password, salt), salt, 'admin']);
      return json(200, { ok: true }, await startSession(r.id, url));
    }

    if (p === '/api/login' && m === 'POST') {
      const body = await readJson(request);
      const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
      // 8 failed attempts per IP+email -> 10 minute lock (kept in the database: functions have no memory)
      const key = sha256(`${ip}|${email}`);
      const lock = await one('SELECT n, (until > ?) AS locked FROM login_fails WHERE key = ?', [Date.now(), key]);
      if (lock && lock.locked) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      const row = await one('SELECT id, pass_hash, salt FROM users WHERE lower(email) = ?', [email]);
      const given = hashPassword(body.password || '', row ? row.salt : 'x'.repeat(32));
      const ok = row && crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(row.pass_hash, 'hex'));
      if (!ok) {
        const n = (lock ? lock.n : 0) + 1, until = n >= 8 ? Date.now() + 10 * 60e3 : 0;
        await db.query(`INSERT INTO login_fails (key, n, until) VALUES (?,?,?)
          ON CONFLICT (key) DO UPDATE SET n = excluded.n, until = excluded.until`, [key, n >= 8 ? 0 : n, until]);
        throw new HttpError(401, 'Email or password is incorrect');
      }
      if (lock) await db.query('DELETE FROM login_fails WHERE key = ?', [key]);
      return json(200, { ok: true }, await startSession(row.id, url));
    }

    if (p === '/api/logout' && m === 'POST') {
      const sid = cookies(request).sid;
      if (sid) await db.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(sid)]);
      return json(200, { ok: true }, { 'Set-Cookie': `sid=; ${cookieFlags(url)}; Max-Age=0` });
    }

    need(user);

    // ---- filter option lists (scoped to what the user may see)
    if (p === '/api/options' && m === 'GET') {
      const scope = user.role === 'customer' ? { sql: 'WHERE lower(customer_name) = ? AND', p: [(user.customer_name || '\u0001').toLowerCase()] } : { sql: 'WHERE', p: [] };
      const list = async col => (await db.query(`SELECT DISTINCT ${col} v FROM vehicles ${scope.sql} ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${col}`, scope.p)).map(r => r.v);
      const [customers, makes, yards, colors, models] = await Promise.all([
        user.role === 'customer' ? [user.customer_name] : list('customer_name'), list('make'), list('yard'), list('color'),
        db.query(`SELECT DISTINCT make, model FROM vehicles ${scope.sql} model IS NOT NULL AND model <> '' ORDER BY model`, scope.p),
      ]);
      return json(200, { customers, makes, yards, colors, models });
    }

    // ---- dashboard numbers
    if (p === '/api/stats' && m === 'GET') {
      const f = buildWhere(q, user);
      // each chart ignores its own filter, so a clicked segment stays in context with the others
      const scoped = (skip, cond) => { const g = buildWhere(q, user, skip); return { sql: `${g.sql ? g.sql + ' AND' : 'WHERE'} ${cond}`, p: g.p }; };
      const group = col => { const g = buildWhere(q, user, [col]); return db.query(`SELECT COALESCE(NULLIF(${col},''),'(Blank)') AS name, COUNT(*)::int AS value FROM vehicles ${g.sql} GROUP BY 1 ORDER BY value DESC, name`, g.p); };
      const ag = scoped(['age'], 'out_date IS NULL AND in_date IS NOT NULL'), di = scoped(['in'], 'in_date IS NOT NULL'), dout = scoped(['out'], 'out_date IS NOT NULL');
      const [totals, ageing, byMake, byModel, byYard, byColor, dailyIn, dailyOut] = await Promise.all([
        one(`SELECT COUNT(*)::int AS total,
            (COUNT(*) FILTER (WHERE out_date IS NULL))::int AS in_yard,
            (COUNT(*) FILTER (WHERE out_date IS NOT NULL))::int AS moved_out,
            (AVG(${DAYS_SQL}) FILTER (WHERE out_date IS NULL))::float8 AS avg_days_in_yard,
            (AVG(${DAYS_SQL}) FILTER (WHERE out_date IS NOT NULL))::float8 AS avg_days_to_exit,
            (MAX(${DAYS_SQL}) FILTER (WHERE out_date IS NULL))::int AS oldest_days,
            (COUNT(*) FILTER (WHERE COALESCE(model, '') = '' OR COALESCE(color, '') = ''))::int AS missing
          FROM vehicles ${f.sql}`, f.p),
        db.query(`SELECT bucket AS name, COUNT(*)::int AS value FROM (
            SELECT CASE WHEN d <= 7 THEN '0-7 days' WHEN d <= 15 THEN '8-15 days' WHEN d <= 30 THEN '16-30 days'
                        WHEN d <= 60 THEN '31-60 days' ELSE 'Over 60 days' END AS bucket
            FROM (SELECT ${DAYS_SQL} AS d FROM vehicles ${ag.sql}) t) b GROUP BY 1`, ag.p),
        group('make'), group('model'), group('yard'), group('color'),
        db.query(`SELECT in_date::text AS d, COUNT(*)::int AS n FROM vehicles ${di.sql} GROUP BY in_date ORDER BY in_date`, di.p),
        db.query(`SELECT out_date::text AS d, COUNT(*)::int AS n FROM vehicles ${dout.sql} GROUP BY out_date ORDER BY out_date`, dout.p),
      ]);
      return json(200, { totals, ageing, byMake, byModel, byYard, byColor, dailyIn, dailyOut });
    }

    // ---- records list
    if (p === '/api/vehicles' && m === 'GET') {
      const f = buildWhere(q, user);
      const size = Math.min(Math.max(parseInt(q.get('size'), 10) || 50, 1), 200);
      const page = Math.max(parseInt(q.get('page'), 10) || 1, 1);
      const sort = SORTS[q.get('sort')] || 'in_date';
      const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
      const [total, rows] = await Promise.all([
        count(`SELECT COUNT(*)::int n FROM vehicles ${f.sql}`, f.p),
        db.query(`SELECT ${ROW_SQL}, ${DAYS_SQL} AS days, updated_by FROM vehicles ${f.sql}
          ORDER BY ${sort} ${dir} NULLS LAST, id DESC LIMIT ?::int OFFSET ?::int`, [...f.p, size, (page - 1) * size]),
      ]);
      return json(200, { total, page, size, rows });
    }

    if (p === '/api/export.csv' && m === 'GET') {
      const f = buildWhere(q, user);
      const rows = await db.query(`SELECT ${ROW_SQL}, ${DAYS_SQL} AS days FROM vehicles ${f.sql} ORDER BY in_date DESC NULLS LAST, id DESC`, f.p);
      const lines = [[...FIELDS.map(k => LABELS[k]), 'Days in yard'].map(csvCell).join(',')];
      for (const r of rows) lines.push([...FIELDS.map(k => r[k]), r.days].map(csvCell).join(','));
      return new Response('﻿' + lines.join('\r\n'), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="yard-stock-${new Date().toISOString().slice(0, 10)}.csv"`, ...SEC_HEADERS } });
    }

    // ---- add a record (admin, handler)
    if (p === '/api/vehicles' && m === 'POST') {
      need(user, 'admin', 'handler');
      const { rec, errors } = normalise(await readJson(request));
      errors.push(...checkRequired(rec, REQUIRED));
      if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errors.push('OUT date cannot be before IN date');
      if (errors.length) throw new HttpError(400, errors.join('. '));
      if (await one('SELECT 1 AS x FROM vehicles WHERE vin = ?', [rec.vin])) throw new HttpError(409, `VIN ${rec.vin} already exists - update that record instead`);
      const r = await one(`INSERT INTO vehicles (${INSERT_COLS}, updated_by) VALUES (${FIELDS.map(k => (k.endsWith('_date') ? '?::date' : '?')).join(',')}, ?) RETURNING id`, [...FIELDS.map(k => rec[k] || null), user.name]);
      return json(201, { id: r.id });
    }

    // ---- bulk add / update, matched on VIN (admin, handler)
    if (p === '/api/vehicles/import' && m === 'POST') {
      need(user, 'admin', 'handler');
      const body = await readJson(request);
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];
      const dryRun = body.dryRun !== false;
      const out = { created: 0, updated: 0, unchanged: 0, errors: [], dryRun };
      const vins = [...new Set(rows.map(r => (r && typeof r === 'object' ? cleanText('vin', r.vin) : '')).filter(Boolean))];
      const existing = new Map((await db.query(`SELECT ${ROW_SQL} FROM vehicles WHERE vin IN (SELECT jsonb_array_elements_text(?::jsonb))`, [JSON.stringify(vins)])).map(r => [r.vin, r]));
      const creates = [], updates = [], seen = new Set();
      rows.forEach((row, i) => {
        const fail = msg => out.errors.push({ row: i + 1, vin: cleanText('vin', row && row.vin), message: msg });
        if (!row || typeof row !== 'object') return fail('Unreadable row');
        const old = existing.get(cleanText('vin', row.vin));
        const { rec, errors } = normalise(row, old);
        if (!rec.vin) errors.unshift('VIN is required');
        if (errors.length) return fail(errors.join('. '));
        if (seen.has(rec.vin)) return fail('VIN appears more than once in this paste');
        seen.add(rec.vin);
        if (!old) {
          if (!rec.five_digit) rec.five_digit = rec.vin.slice(-5);
          const errs = checkRequired(rec, REQUIRED);
          if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errs.push('OUT date cannot be before IN date');
          if (errs.length) return fail('New VIN: ' + errs.join('. '));
          creates.push(rec);
          return void out.created++;
        }
        // existing VIN: only non-empty pasted cells overwrite
        const changes = {};
        for (const k of FIELDS) if (k !== 'vin' && rec[k] && rec[k] !== (old[k] || '')) changes[k] = rec[k];
        const merged = { ...old, ...changes };
        if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) return fail('OUT date cannot be before IN date');
        if (!Object.keys(changes).length) return void out.unchanged++;
        updates.push(merged);
        out.updated++;
      });
      if (!dryRun && (creates.length || updates.length)) {
        await db.tx(async tq => { await insertVehicles(tq, creates, user.name); await updateVehicles(tq, updates, user.name); });
      }
      out.errors = out.errors.slice(0, 200);
      return json(200, out);
    }

    let mm;
    if ((mm = p.match(/^\/api\/vehicles\/(\d{1,9})$/))) {
      const id = Number(mm[1]);
      const old = await one(`SELECT ${ROW_SQL} FROM vehicles WHERE id = ?`, [id]);
      if (m === 'PUT') {
        need(user, 'admin', 'handler');
        if (!old) throw new HttpError(404, 'Record not found');
        const { rec, errors } = normalise(await readJson(request), old);
        const merged = { ...old, ...rec };
        // a mandatory field may not be left empty (old Excel rows with a blank model can stay blank)
        errors.push(...checkRequired(merged, REQUIRED.filter(k => old[k] || k !== 'model')));
        if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) errors.push('OUT date cannot be before IN date');
        if (errors.length) throw new HttpError(400, errors.join('. '));
        if (merged.vin !== old.vin && await one('SELECT 1 AS x FROM vehicles WHERE vin = ? AND id <> ?', [merged.vin, id])) throw new HttpError(409, `VIN ${merged.vin} already exists`);
        await updateVehicles(db.query, [merged], user.name);
        return json(200, { ok: true });
      }
      if (m === 'DELETE') {
        need(user, 'admin');
        if (!old) throw new HttpError(404, 'Record not found');
        await db.query('DELETE FROM vehicles WHERE id = ?', [id]);
        return json(200, { ok: true });
      }
    }

    // ---- user management (admin)
    if (p === '/api/users' && m === 'GET') {
      need(user, 'admin');
      return json(200, { users: await db.query('SELECT id, name, email, role, customer_name, created_at::date::text AS created_at FROM users ORDER BY role, name') });
    }
    if (p === '/api/users' && m === 'POST') {
      need(user, 'admin');
      const { u, errors } = validateUser(await readJson(request), { needPassword: true });
      if (errors.length) throw new HttpError(400, errors.join('. '));
      if (await one('SELECT 1 AS x FROM users WHERE lower(email) = ?', [u.email])) throw new HttpError(409, 'That email already has a login');
      const salt = crypto.randomBytes(16).toString('hex');
      await db.query('INSERT INTO users (name,email,pass_hash,salt,role,customer_name) VALUES (?,?,?,?,?,?)', [u.name, u.email, hashPassword(u.password, salt), salt, u.role, u.customer_name || null]);
      return json(201, { ok: true });
    }
    if ((mm = p.match(/^\/api\/users\/(\d{1,9})$/))) {
      need(user, 'admin');
      const id = Number(mm[1]);
      const old = await one('SELECT id, role FROM users WHERE id = ?', [id]);
      if (!old) throw new HttpError(404, 'User not found');
      const lastAdmin = old.role === 'admin' && (await count("SELECT COUNT(*)::int n FROM users WHERE role = 'admin'")) === 1;
      if (m === 'PUT') {
        const { u, errors } = validateUser(await readJson(request), { needPassword: false });
        if (lastAdmin && u.role !== 'admin') errors.push('This is the only admin - create another admin first');
        if (errors.length) throw new HttpError(400, errors.join('. '));
        if (await one('SELECT 1 AS x FROM users WHERE lower(email) = ? AND id <> ?', [u.email, id])) throw new HttpError(409, 'That email already has a login');
        await db.query('UPDATE users SET name = ?, email = ?, role = ?, customer_name = ? WHERE id = ?', [u.name, u.email, u.role, u.customer_name || null, id]);
        if (u.password) {
          const salt = crypto.randomBytes(16).toString('hex');
          await db.query('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?', [hashPassword(u.password, salt), salt, id]);
          await db.query('DELETE FROM sessions WHERE user_id = ? AND user_id <> ?', [id, user.id]);
        }
        return json(200, { ok: true });
      }
      if (m === 'DELETE') {
        if (id === user.id) throw new HttpError(400, 'You cannot delete your own login');
        if (lastAdmin) throw new HttpError(400, 'This is the only admin');
        await db.query('DELETE FROM users WHERE id = ?', [id]);
        return json(200, { ok: true });
      }
    }

    throw new HttpError(404, 'Not found');
  }

  // request -> response; never throws
  return async function handle(request, { ip = '' } = {}) {
    try {
      return await api(request, new URL(request.url), ip);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: 'Something went wrong on the server' });
    }
  };
}
