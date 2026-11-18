'use strict';
/* Yard Stock Tracker - data layer.
   The browser talks straight to Supabase: sign-in through Supabase Auth, everything else through
   the yt_* database functions (supabase/schema.sql). Access rules are enforced in the database;
   the checks here only give friendly messages before a request is sent.
   api(path, { method, body }) keeps the shape of the old /api/* routes so the screens stay the same. */
(function (root) {
  const FIELDS = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date'];
  const LABELS = { customer_name: 'Customer Name', vin: 'VIN', five_digit: '5 Digit', make: 'Make', model: 'Model', color: 'Color', yard: 'Yard', bl: 'BL', in_date: 'IN date', out_date: 'OUT date' };
  const REQUIRED = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'yard', 'in_date'];
  const UPPER = new Set(['vin', 'five_digit', 'make', 'color', 'yard', 'bl']);
  const AGES = ['0-7 days', '8-15 days', '16-30 days', '31-60 days', 'Over 60 days'];
  const SORTS = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date', 'days'];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const OFFLINE = 'Cannot reach the database. Check your internet connection and try again.';

  // ---------------------------------------------------------------- record clean-up
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
  const checkRequired = (rec, fields) => fields.filter(f => !rec[f]).map(f => `${LABELS[f]} is required`);
  const dbRow = rec => Object.fromEntries(FIELDS.map(k => [k, rec[k] || null]));

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

  // query string from the screens -> filter object for the database functions
  function filtersFrom(q) {
    const f = {};
    const multi = k => q.getAll(k).filter(Boolean).slice(0, 300);
    const cs = multi('customer');
    if (cs.length) f.customer = cs.map(c => c.toLowerCase());
    for (const k of ['make', 'model', 'yard', 'color', 'status']) { const v = multi(k); if (v.length) f[k] = v; }
    const ages = multi('age').filter(a => AGES.includes(a));
    if (ages.length) f.age = ages;
    for (const k of ['in_from', 'in_to', 'out_from', 'out_to']) if (ISO_RE.test(q.get(k) || '')) f[k] = q.get(k);
    if (q.get('missing') === '1') f.missing = '1';
    const s = (q.get('q') || '').trim().slice(0, 60);
    if (s) f.q = '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';
    return f;
  }

  // ---------------------------------------------------------------- backend
  // sb: a Supabase client (supabase.createClient(...))
  function createYardBackend(sb) {
    const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };

    async function rpc(fn, args) {
      let res;
      try { res = await sb.rpc(fn, args || {}); } catch { throw fail(503, OFFLINE); }
      if (!res.error) return res.data;
      const code = res.error.code || '', msg = res.error.message || '';
      if (!code && /fetch|network|load failed/i.test(msg)) throw fail(503, OFFLINE);
      if (res.status === 401 || code === '28000' || /\bjwt\b/i.test(msg)) throw fail(401, 'Please sign in');
      if (code === '42501') throw fail(403, 'Your role is not allowed to do this');
      if (code === '57014') throw fail(504, 'That took too long. Try again with fewer rows.');
      if (code === 'P0001') throw fail(400, msg);  // a message raised by our own database functions
      console.error(res.error);
      throw fail(500, 'Something went wrong in the database');
    }

    async function signIn(email, password) {
      let res;
      try { res = await sb.auth.signInWithPassword({ email, password }); } catch { throw fail(503, OFFLINE); }
      if (!res.error) return;
      const msg = res.error.message || '';
      if (res.error.status === 429) throw fail(429, 'Too many failed attempts. Try again in a few minutes.');
      if (/fetch|network|load failed/i.test(msg)) throw fail(503, OFFLINE);
      throw fail(401, 'Email or password is incorrect');
    }

    async function importRows(body) {
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 20000) : [];
      const dryRun = body.dryRun !== false;
      // New VINs are added under the Customer Name chosen in the upload window (body.customer).
      // A VIN already in the system gets any cell that differs from what is stored; empty cells keep the stored value.
      const customer = cleanText('customer_name', body.customer);
      if (!dryRun && !customer) throw fail(400, 'Fill in the Customer Name first');
      const out = { created: 0, updated: [], unchanged: [], errors: [], dryRun };
      const vins = [...new Set(rows.map(r => (r && typeof r === 'object' ? cleanText('vin', r.vin) : '')).filter(Boolean))];
      const existing = new Map((vins.length ? await rpc('yt_existing', { vins }) : []).map(r => [r.vin, r]));
      const creates = [], updates = [], seen = new Set();
      const SHEET_FIELDS = ['make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date'];
      rows.forEach((row, i) => {
        const rowNo = (row && Number(row._row)) || i + 1;
        const bad = msg => out.errors.push({ row: rowNo, vin: cleanText('vin', row && row.vin), message: msg });
        if (!row || typeof row !== 'object') return bad('Unreadable row');
        const input = { vin: row.vin };
        for (const k of SHEET_FIELDS) if (k in row) input[k] = row[k];
        const { rec, errors } = normalise(input);
        if (!rec.vin) errors.unshift('VIN is required');
        if (errors.length) return bad(errors.join('. '));
        if (seen.has(rec.vin)) return bad('VIN appears more than once in this file');
        seen.add(rec.vin);
        const old = existing.get(rec.vin);
        if (!old) {
          rec.customer_name = customer;
          rec.five_digit = rec.vin.slice(-5);
          // the customer is checked when uploading; the first check of the file can run before it is chosen
          const errs = checkRequired(rec, customer ? REQUIRED : REQUIRED.filter(k => k !== 'customer_name'));
          if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errs.push('OUT date cannot be before IN date');
          if (errs.length) return bad(errs.join('. '));
          creates.push(dbRow(rec));
          return void out.created++;
        }
        const changes = [];
        for (const k of SHEET_FIELDS) {
          const was = old[k] || '';
          if (rec[k] && String(rec[k]).toUpperCase() !== String(was).toUpperCase()) changes.push({ field: k, label: LABELS[k], from: was, to: rec[k] });
        }
        const merged = { ...old };
        for (const ch of changes) merged[ch.field] = ch.to;
        if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) return bad('OUT date cannot be before IN date');
        const shown = { row: rowNo, vin: old.vin, five_digit: old.five_digit, customer_name: old.customer_name };
        if (!changes.length) return void out.unchanged.push({ ...shown, yard: old.yard, in_date: old.in_date, out_date: old.out_date });
        updates.push({ id: old.id, ...dbRow(merged) });
        out.updated.push({ ...shown, changes });
      });
      // sent in batches so a very large file stays inside the database's time limit
      const BATCH = 4000;
      if (!dryRun) {
        let added = 0;
        for (let i = 0; i < creates.length; i += BATCH) added += (await rpc('yt_apply', { creates: creates.slice(i, i + BATCH), updates: [] })).created;
        for (let i = 0; i < updates.length; i += BATCH) await rpc('yt_apply', { creates: [], updates: updates.slice(i, i + BATCH) });
        out.created = added;  // a VIN someone else added in the meantime is skipped, not duplicated
      }
      out.updatedTotal = out.updated.length;
      out.unchangedTotal = out.unchanged.length;
      out.updated = out.updated.slice(0, 1000);
      out.unchanged = out.unchanged.slice(0, 1000);
      out.errors = out.errors.slice(0, 200);
      return out;
    }

    async function api(path, { method = 'GET', body } = {}) {
      const url = new URL(path, 'http://app.local');
      const p = url.pathname, m = method, q = url.searchParams;
      body = body && typeof body === 'object' ? body : {};
      let mm;

      if (p === '/api/me' && m === 'GET') {
        const me = await rpc('yt_me');
        // a saved sign-in whose login has been removed: forget it
        if (!me.user) { try { const s = await sb.auth.getSession(); if (s.data && s.data.session) await sb.auth.signOut({ scope: 'local' }); } catch { /* ignore */ } }
        return me;
      }
      if (p === '/api/setup' && m === 'POST') {
        const { u, errors } = validateUser({ ...body, role: 'admin' }, { needPassword: true });
        if (errors.length) throw fail(400, errors.join('. '));
        await rpc('yt_setup', { u: { name: u.name, email: u.email, password: u.password } });
        await signIn(u.email, u.password);
        return { ok: true };
      }
      if (p === '/api/login' && m === 'POST') {
        await signIn(String(body.email || '').trim().toLowerCase().slice(0, 200), String(body.password || ''));
        return { ok: true };
      }
      if (p === '/api/logout' && m === 'POST') {
        try { await sb.auth.signOut(); } catch { /* signing out locally is enough */ }
        return { ok: true };
      }

      if (p === '/api/options' && m === 'GET') return rpc('yt_options');
      if (p === '/api/stats' && m === 'GET') return rpc('yt_stats', { f: filtersFrom(q) });
      if (p === '/api/vehicles' && m === 'GET') {
        return rpc('yt_vehicles', {
          f: filtersFrom(q), page: parseInt(q.get('page'), 10) || 1, size: parseInt(q.get('size'), 10) || 50,
          sort: SORTS.includes(q.get('sort')) ? q.get('sort') : 'in_date', dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
        });
      }
      if (p === '/api/export' && m === 'GET') return { rows: await rpc('yt_export', { f: filtersFrom(q) }) };

      if (p === '/api/vehicles' && m === 'POST') {
        const { rec, errors } = normalise(body);
        rec.five_digit = (rec.vin || '').slice(-5);  // always taken from the VIN
        errors.push(...checkRequired(rec, REQUIRED));
        if (rec.in_date && rec.out_date && rec.out_date < rec.in_date) errors.push('OUT date cannot be before IN date');
        if (errors.length) throw fail(400, errors.join('. '));
        return rpc('yt_vehicle_add', { rec: dbRow(rec) });
      }
      if (p === '/api/vehicles/import' && m === 'POST') return importRows(body);
      // Add / Update form: is this VIN already in the system?
      if (p === '/api/vehicles/find-vin' && m === 'POST') {
        const vin = cleanText('vin', body.vin);
        return { rows: /^[A-Z0-9]{5,20}$/.test(vin) ? await rpc('yt_existing', { vins: [vin] }) : [] };
      }
      // bulk update: look up by 5 Digit, then set a new Yard and/or OUT date on the chosen records
      if (p === '/api/vehicles/find-five' && m === 'POST') {
        const fives = [...new Set((Array.isArray(body.fives) ? body.fives : []).map(f => cleanText('five_digit', f)).filter(Boolean))].slice(0, 2000);
        return { rows: fives.length ? await rpc('yt_by_five', { fives }) : [] };
      }
      if (p === '/api/vehicles/bulk-update' && m === 'POST') {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 5000);
        if (!ids.length) throw fail(400, 'Select at least one record');
        const yard = cleanText('yard', body.yard);
        const out = parseDate(body.out_date);
        if (out === undefined) throw fail(400, 'OUT date is not a valid date');
        if (!yard && !out) throw fail(400, 'Enter a new Yard, an OUT date, or both');
        return rpc('yt_bulk_update', { ids, p_yard: yard, p_out: out });
      }
      if ((mm = p.match(/^\/api\/vehicles\/(\d{1,9})$/))) {
        const id = Number(mm[1]);
        if (m === 'PUT') {
          const old = await rpc('yt_vehicle', { p_id: id });
          if (!old) throw fail(404, 'Record not found');
          const { rec, errors } = normalise(body, old);
          // 5 Digit follows the VIN: a new VIN gives a new 5 Digit, otherwise the stored one stays
          delete rec.five_digit;
          if (rec.vin && rec.vin !== old.vin) rec.five_digit = rec.vin.slice(-5);
          const merged = { ...old, ...rec };
          // a mandatory field may not be left empty (old Excel rows with a blank model can stay blank)
          errors.push(...checkRequired(merged, REQUIRED.filter(k => old[k] || k !== 'model')));
          if (merged.in_date && merged.out_date && merged.out_date < merged.in_date) errors.push('OUT date cannot be before IN date');
          if (errors.length) throw fail(400, errors.join('. '));
          return rpc('yt_vehicle_update', { p_id: id, rec: dbRow(merged) });
        }
        if (m === 'DELETE') return rpc('yt_vehicle_delete', { p_id: id });
      }

      if (p === '/api/users' && m === 'GET') return { users: await rpc('yt_users') };
      if (p === '/api/users' && m === 'POST') {
        const { u, errors } = validateUser(body, { needPassword: true });
        if (errors.length) throw fail(400, errors.join('. '));
        return rpc('yt_user_create', { u });
      }
      if ((mm = p.match(/^\/api\/users\/([0-9a-f-]{36})$/i))) {
        if (m === 'PUT') {
          const { u, errors } = validateUser(body, { needPassword: false });
          if (errors.length) throw fail(400, errors.join('. '));
          return rpc('yt_user_update', { p_id: mm[1], u });
        }
        if (m === 'DELETE') return rpc('yt_user_delete', { p_id: mm[1] });
      }
      throw fail(404, 'Not found');
    }

    return { api };
  }

  root.createYardBackend = createYardBackend;

  // In the browser: connect using public/config.js and expose yardApi(path, options).
  const cfg = root.YARD_CONFIG || {};
  const ready = root.supabase && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_KEY;
  if (ready) {
    const sb = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    const backend = createYardBackend(sb);
    root.yardApi = backend.api;
    // signed out in another tab, or the saved sign-in could not be renewed
    root.yardOnSignedOut = fn => sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') fn(); });
  } else {
    root.yardApi = async () => { throw new Error('This site is not connected to its database yet (public/config.js is not filled in).'); };
    root.yardOnSignedOut = () => {};
  }
})(typeof window !== 'undefined' ? window : globalThis);
