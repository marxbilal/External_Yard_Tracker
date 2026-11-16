'use strict';
/* Yard Stock Tracker - browser app (no libraries). */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-US');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}-${MON[m - 1]}-${y}`; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// customer / make / model / yard / status hold a list of ticked values (empty list = All)
// color / age / out_* are only set by clicking a chart; they show as chips under the filter bar
const newFilters = () => ({ customer: [], make: [], model: [], yard: [], status: [], color: [], age: [], in_from: '', in_to: '', out_from: '', out_to: '' });
const STATUS_OPTS = [['in', 'In yard'], ['out', 'Moved out']];
const S = {
  user: null, view: 'dashboard', options: { customers: [], makes: [], models: [], yards: [], colors: [] },
  filters: newFilters(), missing: false, q: '', page: 1, sort: 'in_date', dir: 'desc',
};
const canEdit = () => S.user && (S.user.role === 'admin' || S.user.role === 'handler');
const isAdmin = () => S.user && S.user.role === 'admin';

// All data goes through backend.js, which talks straight to the database (Supabase).
function sessionEnded() {
  if (!S.user) return;
  S.user = null; renderLogin('Your session has ended. Please sign in again.');
}
async function api(path, opts) {
  try { return await yardApi(path, opts); }
  catch (e) { if (e.status === 401) sessionEnded(); throw e; }
}
yardOnSignedOut(sessionEnded);
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function filterQuery(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...S.filters, ...extra })) {
    if (Array.isArray(v)) v.forEach(x => p.append(k, x));
    else if (v) p.set(k, v);
  }
  if (S.missing) p.set('missing', '1');
  return p.toString();
}

// ------------------------------------------------------------------ sign in / first-run setup
function renderLogin(message) {
  $('#modal-root').innerHTML = '';
  $('#app').innerHTML = `<div class="center"><form class="card login form" id="login-form">
    <div><h1>Yard Stock Tracker</h1><p class="muted">Sign in to continue</p></div>
    ${message ? `<div class="err">${esc(message)}</div>` : ''}
    <div class="f"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
    <div class="f"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
    <div id="l-err"></div>
    <button class="btn primary" type="submit">Sign in</button>
  </form></div>`;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/login', { method: 'POST', body: { email: $('#l-email').value, password: $('#l-pass').value } }); boot(); }
    catch (err) { $('#l-err').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
  $('#l-email').focus();
}
function renderSetup() {
  $('#app').innerHTML = `<div class="center"><form class="card login form" id="setup-form">
    <div><h1>Welcome</h1><p class="muted">Create the first admin login for Yard Stock Tracker. You can add handlers and customers afterwards.</p></div>
    <div class="f"><label for="s-name">Your name</label><input id="s-name" required></div>
    <div class="f"><label for="s-email">Email</label><input id="s-email" type="email" autocomplete="username" required></div>
    <div class="f"><label for="s-pass">Password (min 8 characters)</label><input id="s-pass" type="password" autocomplete="new-password" minlength="8" required></div>
    <div id="s-err"></div>
    <button class="btn primary" type="submit">Create admin</button>
  </form></div>`;
  $('#setup-form').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/setup', { method: 'POST', body: { name: $('#s-name').value, email: $('#s-email').value, password: $('#s-pass').value } }); boot(); }
    catch (err) { $('#s-err').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ shell
function renderShell() {
  const tabs = [['dashboard', 'Dashboard'], ['records', 'Records']];
  if (isAdmin()) tabs.push(['users', 'Users']);
  $('#app').innerHTML = `<header class="topbar">
      <div class="brand">Yard Stock Tracker</div>
      <nav class="nav">${tabs.map(([k, l]) => `<button data-nav="${k}" class="${S.view === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <div class="who"><span>${esc(S.user.name)}</span><span class="role">${esc(S.user.role)}</span><button class="btn small" data-act="logout">Sign out</button></div>
    </header><main class="page" id="view"></main>`;
}
async function go(view) {
  S.view = view;
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('on', b.dataset.nav === view));
  try {
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'records') await renderRecords();
    else if (view === 'users') await renderUsers();
    restoreMs();
  } catch (e) { if (S.user) $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function loadOptions() { S.options = await api('/api/options'); }

function filterBar() {
  const f = S.filters, o = S.options;
  // checkbox dropdown: tick any number of values, then Done
  const sel = (key, label, values) => {
    const opts = values.map(v => (Array.isArray(v) ? v : [v, v])), cur = f[key];
    const text = !cur.length ? 'All' : cur.length === 1 ? (opts.find(x => x[0] === cur[0]) || [0, cur[0]])[1] : `${cur.length} selected`;
    return `<div class="fld ms" data-ms="${key}"><label id="l-${key}">${label}</label>
      <button type="button" id="f-${key}" class="ms-btn${cur.length ? ' set' : ''}" data-act="ms-toggle" aria-haspopup="true" aria-expanded="false" aria-labelledby="l-${key} f-${key}"><span>${esc(text)}</span><i aria-hidden="true">▼</i></button>
      <div class="ms-panel" hidden><div class="ms-head"><button type="button" class="ms-clear" data-act="ms-clear">Clear</button></div>
        <div class="ms-list">${opts.map(([v, l]) => `<label><input type="checkbox" value="${esc(v)}" ${cur.includes(v) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('') || '<p class="muted">No values</p>'}</div></div></div>`;
  };
  const models = [...new Set(o.models.filter(m => !f.make.length || f.make.includes(m.make)).map(m => m.model))];
  const customer = S.user.role === 'customer'
    ? `<div class="fld"><label>Customer</label><div class="locked">${esc(S.user.customer_name)}</div></div>`
    : sel('customer', 'Customer', o.customers);
  const chips = [];
  if (f.color.length) chips.push(['color', 'Colour: ' + f.color.join(', ')]);
  if (f.age.length) chips.push(['age', 'Ageing: ' + f.age.join(', ')]);
  if (f.out_from || f.out_to) chips.push(['out', 'OUT date: ' + (f.out_from === f.out_to ? fmtDate(f.out_from) : `${fmtDate(f.out_from)} – ${fmtDate(f.out_to)}`)]);
  return `<section class="card filters" aria-label="Filters">
    ${customer}${sel('make', 'Make', o.makes)}${sel('model', 'Model', models)}${sel('yard', 'Yard', o.yards)}
    ${sel('status', 'Vehicle status', STATUS_OPTS)}
    <div class="fld date"><label for="f-in_from">IN date</label><div class="range">
      <input type="date" id="f-in_from" data-f="in_from" value="${esc(f.in_from)}" class="${f.in_from ? 'set' : ''}" aria-label="IN date from"><span>–</span>
      <input type="date" data-f="in_to" value="${esc(f.in_to)}" class="${f.in_to ? 'set' : ''}" aria-label="IN date to"></div></div>
    <div class="spacer"></div><button class="btn" data-act="reset-filters">Reset all filters</button>
    ${chips.length ? `<div class="chips">${chips.map(([k, t]) => `<span class="chip">${esc(t)}<button data-act="clear-f" data-key="${k}" aria-label="Remove filter ${esc(t)}">✕</button></span>`).join('')}</div>` : ''}
  </section>`;
}

// ------------------------------------------------------------------ charts
const RAMP = ['#5b3470', '#6c3d84', '#7d4797', '#8e52a9', '#9f61ba', '#b075c9', '#c08bd6', '#cfa2e1'];
const OTHER = '#8f8c97';
const rampAt = (i, n) => RAMP[Math.min(RAMP.length - 1, Math.round(i * (RAMP.length - 1) / Math.max(n - 1, 1)))];
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function niceMax(v) {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}
// A chart segment: click to filter the whole page by it, hover for the tooltip.
// When its chart has a selection, segments outside the selection are drawn faded.
const isDim = (key, name) => { const sel = S.filters[key] || []; return sel.length > 0 && !sel.includes(name); };
const tipAttr = (title, body) => `data-tt="${esc(title)}" data-tb="${esc(body)}"`;
function segAttr(key, name, cls, tipBody) {
  const can = name !== 'Other';
  return `class="${cls}${can ? ' clickable' : ''}${isDim(key, name) ? ' dim' : ''}" ${can ? `data-pick="${key}" data-val="${esc(name)}" tabindex="0" role="button" aria-pressed="${(S.filters[key] || []).includes(name)}"` : ''} ${tipAttr(name, tipBody)}`;
}

function donut(items, key) {
  const total = items.reduce((a, b) => a + b.value, 0);
  if (!total) return '<div class="empty">No units match the current filters</div>';
  const parts = items.slice(0, 8).map((d, i) => ({ ...d, color: RAMP[i] }));
  const rest = items.slice(8).reduce((a, b) => a + b.value, 0);
  if (rest) parts.push({ name: 'Other', value: rest, color: OTHER });
  const cx = 230, cy = 150, R = 108, r = 68;
  let a = -Math.PI / 2, paths = '', labels = '';
  const pt = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(1)} ${(cy + rad * Math.sin(ang)).toFixed(1)}`;
  for (const d of parts) {
    const frac = d.value / total, a1 = a + Math.min(frac, 0.99999) * 2 * Math.PI, big = frac > 0.5 ? 1 : 0;
    const pct = (frac * 100).toFixed(1) + '%';
    paths += `<path ${segAttr(key, d.name, 'seg-p', `Units: ${fmt(d.value)} · ${(frac * 100).toFixed(2)}%`)} fill="${d.color}" d="M${pt(R, a)} A${R} ${R} 0 ${big} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${big} 0 ${pt(r, a)}Z"/>`;
    if (frac >= 0.035) {
      const mid = (a + a1) / 2, c = Math.cos(mid), lx = cx + (R + 12) * c, ly = cy + (R + 12) * Math.sin(mid);
      const anchor = c > 0.2 ? 'start' : c < -0.2 ? 'end' : 'middle';
      labels += `<text ${isDim(key, d.name) ? 'class="dim"' : ''} text-anchor="${anchor}" x="${lx.toFixed(1)}" y="${(ly - 2).toFixed(1)}">${esc(cut(d.name, 16))}<tspan x="${lx.toFixed(1)}" dy="14">${pct}</tspan></text>`;
    }
    a = a1;
  }
  return `<div class="donut"><svg viewBox="0 0 460 300" role="img" aria-label="Share of units">${paths}${labels}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" style="font-size:22px;font-weight:700">${fmt(total)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" style="font-weight:400">units</text></svg>
    <div class="legend">${parts.map(d => `<span><i style="background:${d.color}"></i>${esc(d.name)}</span>`).join('')}</div></div>`;
}

function hbar(items, key, limit = 16) {
  if (!items.length || !items.some(d => d.value)) return '<div class="empty">No units match the current filters</div>';
  const rows = items.slice(0, limit);
  const rest = items.slice(limit).reduce((a, b) => a + b.value, 0);
  if (rest) rows.push({ name: 'Other', value: rest, other: true });
  const max = niceMax(Math.max(...rows.map(d => d.value))), ticks = 5, sum = rows.reduce((a, b) => a + b.value, 0);
  let html = '';
  rows.forEach((d, i) => {
    const w = (d.value / max * 100).toFixed(2), dim = isDim(key, d.name) ? ' dim' : '';
    html += `<div class="hb-l${dim}">${esc(d.name)}</div>
      <div class="hb-t" style="background-size:${100 / ticks}% 100%"><div ${segAttr(key, d.name, 'hb-b', `Units: ${fmt(d.value)} · ${(d.value / sum * 100).toFixed(2)}%`)} style="width:${w}%;background:${d.other ? OTHER : rampAt(i, rows.length)}"></div><span class="hb-v${dim}" style="left:${w}%">${fmt(d.value)}</span></div>`;
  });
  let axis = '';
  for (let i = 0; i <= ticks; i++) axis += `<span style="left:${i * 100 / ticks}%">${fmt(max * i / ticks)}</span>`;
  return `<div class="hbar">${html}<div></div><div class="hb-axis">${axis}</div></div>`;
}

// IN / OUT movement per day (per week or month on long ranges)
function movement(dailyIn, dailyOut) {
  const all = [...dailyIn, ...dailyOut].map(d => d.d).sort();
  if (!all.length) return { html: '<div class="empty">No units match the current filters</div>', rows: [] };
  const toD = iso => new Date(iso + 'T00:00:00Z'), iso = d => d.toISOString().slice(0, 10);
  const span = (toD(all[all.length - 1]) - toD(all[0])) / 864e5 + 1;
  const mode = span <= 45 ? 'day' : span <= 370 ? 'week' : 'month';
  const bucket = s => {
    if (mode === 'day') return s;
    if (mode === 'month') return s.slice(0, 7) + '-01';
    const d = toD(s); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return iso(d);
  };
  const map = new Map();
  for (let d = toD(bucket(all[0])); d <= toD(all[all.length - 1]);) {
    map.set(iso(d), { d: iso(d), inn: 0, out: 0 });
    if (mode === 'day') d.setUTCDate(d.getUTCDate() + 1); else if (mode === 'week') d.setUTCDate(d.getUTCDate() + 7); else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  dailyIn.forEach(x => { map.get(bucket(x.d)).inn += x.n; });
  dailyOut.forEach(x => { map.get(bucket(x.d)).out += x.n; });
  const rows = [...map.values()];
  const label = s => (mode === 'month' ? `${MON[s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : `${s.slice(8)} ${MON[s.slice(5, 7) - 1]}`);
  const W = 1000, H = 300, L = 48, Rr = 10, T = 14, B = 34, pw = W - L - Rr, ph = H - T - B;
  const max = niceMax(Math.max(...rows.map(r => Math.max(r.inn, r.out)))), step = pw / rows.length, bw = Math.max(2, Math.min(16, step * 0.36));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + ph - ph * i / 4;
    g += `<line class="grid" x1="${L}" x2="${W - Rr}" y1="${y}" y2="${y}"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${fmt(max * i / 4)}</text>`;
  }
  const every = Math.ceil(rows.length / 16);
  // last day covered by a bar, so a click can filter that exact period
  const endOf = s => {
    if (mode === 'day') return s;
    const d = toD(s);
    if (mode === 'week') d.setUTCDate(d.getUTCDate() + 6); else { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
    return iso(d);
  };
  const bar = (kind, r, x, h, n, fill) => {
    const from = r.d, to = endOf(r.d), f0 = S.filters[kind + '_from'], f1 = S.filters[kind + '_to'];
    const dim = (f0 || f1) && ((f0 && to < f0) || (f1 && from > f1));
    return `<rect class="clickable${dim ? ' dim' : ''}" data-range="${kind}" data-from="${from}" data-to="${to}" tabindex="0" role="button" ${tipAttr(label(r.d), `${kind.toUpperCase()}: ${fmt(n)} units`)} x="${x.toFixed(1)}" y="${(T + ph - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}"/>`;
  };
  rows.forEach((r, i) => {
    const x = L + step * i + step / 2, hi = ph * r.inn / max, ho = ph * r.out / max;
    if (r.inn) g += bar('in', r, x - bw - 1, hi, r.inn, '#5b3470');
    if (r.out) g += bar('out', r, x + 1, ho, r.out, '#e8961e');
    if (i % every === 0) g += `<text x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle">${label(r.d)}</text>`;
  });
  const unit = mode === 'day' ? 'per day' : mode === 'week' ? 'per week (week starting)' : 'per month';
  return {
    rows: rows.filter(r => r.inn || r.out).map(r => ({ name: label(r.d), inn: r.inn, out: r.out })),
    html: `<div class="vbar"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Units in and out ${unit}">${g}</svg>
      <div class="legend"><span><i style="background:#5b3470"></i>IN</span><span><i style="background:#e8961e"></i>OUT</span><span class="muted">${unit}</span></div></div>`,
  };
}

function shareTable(items, head = 'Name') {
  const sum = items.reduce((a, b) => a + b.value, 0), total = sum || 1;
  return `<table><thead><tr><th class="sno">S.No</th><th>${head}</th><th class="num">Units</th><th class="num">Share</th></tr></thead><tbody>
    ${items.map((d, i) => `<tr><td class="sno">${i + 1}</td><td>${esc(d.name)}</td><td class="num">${fmt(d.value)}</td><td class="num">${(d.value / total * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
    <tfoot><tr><td></td><td>Total</td><td class="num">${fmt(sum)}</td><td class="num">${sum ? '100.0%' : '–'}</td></tr></tfoot></table>`;
}
function chartCard(title, chartHtml, tableHtml, wide) {
  return `<section class="card chart${wide ? ' wide' : ''}"><div class="chart-head"><h2>${title}</h2>
      <div class="seg"><button class="on" data-act="as-chart">Chart</button><button data-act="as-table">Table</button></div></div>
    <div class="as-chart">${chartHtml}</div><div class="as-table">${tableHtml}</div></section>`;
}

// ------------------------------------------------------------------ dashboard
async function renderDashboard() {
  const st = await api('/api/stats?' + filterQuery());
  const t = st.totals, total = t.total || 0;
  const kpi = (k, v, n = '') => `<div class="card kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="n">${n}</div></div>`;
  const days = v => (v === null || v === undefined ? '–' : Number(v).toFixed(1));
  const order = ['0-7 days', '8-15 days', '16-30 days', '31-60 days', 'Over 60 days'];
  const ageing = order.map(name => ({ name, value: (st.ageing.find(a => a.name === name) || {}).value || 0 }));
  const mv = movement(st.dailyIn, st.dailyOut);
  const scope = S.user.role === 'customer' ? `Stock held for ${esc(S.user.customer_name)}.` : 'Stock position, movement and ageing across customers, brands, models and yards.';
  $('#view').innerHTML = `<h1>Yard Dashboard</h1><p class="sub">${scope} Click any chart segment to filter the whole page by it; click it again to clear.</p>
    ${filterBar()}
    <div class="kpis">
      ${kpi('Total units', fmt(total), 'in current selection')}
      ${kpi('In yard', fmt(t.in_yard), 'no OUT date yet')}
      ${kpi('Moved out', fmt(t.moved_out), 'OUT date recorded')}
      ${kpi('Out %', total ? (t.moved_out / total * 100).toFixed(1) + '%' : '–', 'of units received')}
      ${kpi('Avg days in yard', days(t.avg_days_in_yard), t.oldest_days === null ? 'units still in yard' : `oldest unit: ${fmt(t.oldest_days)} days`)}
      ${kpi('Avg days to exit', days(t.avg_days_to_exit), 'IN to OUT, moved units')}
    </div>
    ${t.missing ? `<button class="card notice" data-act="show-missing"><b>Some units are missing details</b>${fmt(t.missing)} of ${fmt(total)} units in the current selection have no model or colour recorded. Click to list just these units.</button>` : ''}
    <div class="grid2">
      ${chartCard('Units by Brand', donut(st.byMake, 'make'), shareTable(st.byMake, 'Brand'))}
      ${chartCard('Units by Yard', donut(st.byYard, 'yard'), shareTable(st.byYard, 'Yard'))}
      ${chartCard('Units by Model', hbar(st.byModel, 'model'), shareTable(st.byModel, 'Model'))}
      ${chartCard('Units by Colour', hbar(st.byColor, 'color', 15), shareTable(st.byColor, 'Colour'))}
      ${chartCard('Ageing of Units in Yard', hbar(ageing, 'age'), shareTable(ageing, 'Days since IN'), true)}
      ${chartCard('Daily Movement (IN vs OUT)', mv.html, `<table><thead><tr><th>Period</th><th class="num">IN</th><th class="num">OUT</th></tr></thead><tbody>${mv.rows.map(r => `<tr><td>${r.name}</td><td class="num">${fmt(r.inn)}</td><td class="num">${fmt(r.out)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${fmt(mv.rows.reduce((a, r) => a + r.inn, 0))}</td><td class="num">${fmt(mv.rows.reduce((a, r) => a + r.out, 0))}</td></tr></tfoot></table>`, true)}    </div>`;
}

// ------------------------------------------------------------------ records
const COLS = [['customer_name', 'Customer'], ['vin', 'VIN'], ['five_digit', '5 Digit'], ['make', 'Make'], ['model', 'Model'], ['color', 'Color'], ['yard', 'Yard'], ['bl', 'BL'], ['in_date', 'IN'], ['out_date', 'OUT'], ['days', 'Days']];
// The list scrolls inside its own box and fetches the next batch as you near the bottom.
const REC_BATCH = 200;
let recordRows = [], recTotal = 0, recBatches = 0, recLoading = false, recGen = 0, recRestore = null;
const recQuery = page => filterQuery({ q: S.q, page, sort: S.sort, dir: S.dir, size: REC_BATCH });
const recordRow = r => `<tr>
  <td>${esc(r.customer_name)}</td><td class="mono">${esc(r.vin)}</td><td class="mono">${esc(r.five_digit)}</td><td>${esc(r.make)}</td><td>${esc(r.model)}</td>
  <td>${esc(r.color)}</td><td>${esc(r.yard)}</td><td class="mono">${esc(r.bl)}</td><td>${fmtDate(r.in_date)}</td><td>${fmtDate(r.out_date)}</td><td class="num">${r.days ?? ''}</td>
  <td><span class="pill ${r.out_date ? 'out' : 'in'}">${r.out_date ? 'Moved out' : 'In yard'}</span></td>
  ${canEdit() ? `<td><button class="btn small" data-act="edit" data-id="${r.id}">Update</button>${isAdmin() ? ` <button class="btn small danger" data-act="delete" data-id="${r.id}">Delete</button>` : ''}</td>` : ''}
</tr>`;
function recCount() {
  const el = $('#rec-count');
  if (el) el.textContent = recordRows.length >= recTotal ? `All ${fmt(recTotal)} units shown` : `Showing ${fmt(recordRows.length)} of ${fmt(recTotal)} units - scroll down for more`;
}
async function loadMoreRecords() {
  if (recLoading || recordRows.length >= recTotal) return;
  const gen = recGen;
  recLoading = true;
  try {
    const d = await api('/api/vehicles?' + recQuery(recBatches + 1));
    if (gen !== recGen) return; // filters changed while this batch was loading
    recBatches++; recTotal = d.total; recordRows.push(...d.rows);
    const body = $('#rec-body');
    if (body) body.insertAdjacentHTML('beforeend', d.rows.map(recordRow).join(''));
    recCount();
    if (!d.rows.length) recTotal = recordRows.length;
  } finally { if (gen === recGen) recLoading = false; }
}
// call before re-rendering after an edit, so the list comes back at the same place
function keepRecScroll() { const w = $('#rec-wrap'); if (w) recRestore = { batches: recBatches, top: w.scrollTop }; }
async function renderRecords() {
  const restore = recRestore, gen = ++recGen;
  recRestore = null; recLoading = false;
  const data = await api('/api/vehicles?' + recQuery(1));
  if (gen !== recGen) return;
  recordRows = data.rows; recTotal = data.total; recBatches = 1;
  const arrow = k => (S.sort === k ? (S.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const focusSearch = document.activeElement && document.activeElement.id === 'search';
  $('#view').innerHTML = `<h1>Yard Records</h1><p class="sub">Every vehicle with its yard, IN and OUT dates.${canEdit() ? ' Add new arrivals or update the yard and dates of existing units.' : ''}</p>
    ${filterBar()}
    <section class="card">
      <div class="toolbar">
        <input type="search" id="search" placeholder="Search VIN, 5 digit or BL" value="${esc(S.q)}" aria-label="Search">
        ${S.missing ? '<span class="chip">Missing model / colour<button data-act="clear-missing" aria-label="Remove">✕</button></span>' : ''}
        <span class="muted">${fmt(data.total)} units</span><span class="grow"></span>
        ${canEdit() ? '<button class="btn primary" data-act="add">+ Add record</button><button class="btn" data-act="bulk">Bulk paste from Excel</button>' : ''}
        <button class="btn" data-act="export">Download CSV</button>
      </div>
      <div class="table-wrap" id="rec-wrap" tabindex="0" aria-label="Records list"><table><thead><tr>
        ${COLS.map(([k, l]) => `<th class="sortable${k === 'days' ? ' num' : ''}" data-sort="${k}">${l}${arrow(k)}</th>`).join('')}<th>Status</th>${canEdit() ? '<th></th>' : ''}
      </tr></thead><tbody id="rec-body">
      ${data.rows.map(recordRow).join('') || `<tr><td colspan="${COLS.length + 2}" class="empty">No records match the current filters</td></tr>`}
      </tbody></table></div>
      <div class="pager"><span id="rec-count" class="muted"></span></div>
    </section>`;
  recCount();
  if (focusSearch) { const s = $('#search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  const wrap = $('#rec-wrap');
  wrap.addEventListener('scroll', () => { if (wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 600) loadMoreRecords(); });
  if (restore) {
    while (gen === recGen && recBatches < restore.batches && recordRows.length < recTotal) await loadMoreRecords();
    if (gen === recGen) wrap.scrollTop = restore.top;
  }
}

// ------------------------------------------------------------------ modals
function openModal(html) {
  $('#modal-root').innerHTML = `<div class="overlay"><div class="card modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const first = $('#modal-root input:not([disabled]), #modal-root textarea');
  if (first) first.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function vehicleForm(rec) {
  const edit = !!rec; rec = rec || { customer_name: '', in_date: today() };
  const o = S.options;
  const list = (id, vals) => `<datalist id="${id}">${vals.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const inp = (k, label, req, attrs = '') => `<div class="f"><label for="v-${k}" class="${req ? 'req' : ''}">${label}</label><input id="v-${k}" name="${k}" value="${esc(rec[k] || '')}" ${req ? 'required' : ''} ${attrs}></div>`;
  openModal(`<h2>${edit ? 'Update record' : 'Add record'}</h2>
    <form class="form" id="vehicle-form" data-id="${edit ? rec.id : ''}">
      <div class="two">${inp('vin', 'VIN', true, 'maxlength="20" autocomplete="off" style="text-transform:uppercase"')}${inp('five_digit', '5 Digit', true, 'maxlength="6" autocomplete="off" style="text-transform:uppercase"')}</div>
      <div class="two">${inp('make', 'Make', true, 'list="dl-make"')}${inp('model', 'Model', !edit || !!rec.model, 'list="dl-model"')}</div>
      <div class="two">${inp('yard', 'Yard', true, 'list="dl-yard"')}${inp('color', 'Color', false, 'list="dl-color"')}</div>
      <div class="two">${inp('in_date', 'IN date', true, 'type="date"')}${inp('out_date', 'OUT date', false, 'type="date"')}</div>
      <div class="two">${inp('customer_name', 'Customer Name', false, 'list="dl-cust"')}${inp('bl', 'BL', false)}</div>
      ${list('dl-make', o.makes)}${list('dl-model', [...new Set(o.models.map(m => m.model))])}${list('dl-yard', o.yards)}${list('dl-color', o.colors)}${list('dl-cust', o.customers)}
      <p class="hint">Fields marked * are mandatory. 5 Digit fills in from the last five characters of the VIN.</p>
      <div id="v-err"></div>
      <div class="actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">${edit ? 'Save changes' : 'Add record'}</button></div>
    </form>`);
  const vin = $('#v-vin'), five = $('#v-five_digit');
  let auto = !edit;
  five.addEventListener('input', () => { auto = false; });
  vin.addEventListener('input', () => { if (auto) five.value = vin.value.trim().slice(-5).toUpperCase(); });
  $('#vehicle-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const id = e.target.dataset.id;
    try {
      await api(id ? `/api/vehicles/${id}` : '/api/vehicles', { method: id ? 'PUT' : 'POST', body });
      if (id) keepRecScroll();
      closeModal(); toast(id ? 'Record updated' : 'Record added');
      await loadOptions(); go(S.view);
    } catch (err) { $('#v-err').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
}

// ---- bulk paste
const HEADER_MAP = { 'customer name': 'customer_name', customer: 'customer_name', vin: 'vin', '5 digit': 'five_digit', '5digit': 'five_digit', 'five digit': 'five_digit', make: 'make', model: 'model', color: 'color', colour: 'color', yard: 'yard', bl: 'bl', in: 'in_date', 'in date': 'in_date', out: 'out_date', 'out date': 'out_date' };
const DEFAULT_ORDER = ['customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date'];
function parseGrid(text) {
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.filter(r => r.some(x => x.trim()));
}
function gridToRecords(grid) {
  if (!grid.length) return [];
  const head = grid[0].map(h => HEADER_MAP[h.trim().toLowerCase()]);
  const hasHeader = head.includes('vin');
  const keys = hasHeader ? head : DEFAULT_ORDER;
  return grid.slice(hasHeader ? 1 : 0).map(r => { const o = {}; keys.forEach((k, i) => { if (k && r[i] !== undefined) o[k] = r[i].trim(); }); return o; });
}
function bulkModal() {
  openModal(`<h2>Bulk paste from Excel</h2>
    <form class="form" id="bulk-form">
      <p class="hint">Copy rows from Excel (with the header row) and paste below. Columns: Customer Name, VIN, 5 DIGIT, MAKE, MODEL, COLOR, YARD, BL, IN, OUT.
        A VIN that is not in the system is added as a new record; a VIN that already exists is updated with whatever cells you filled in (e.g. just VIN + YARD, or VIN + OUT). Dates like 08/10/2026 are read as day/month/year.</p>
      <textarea id="bulk-text" placeholder="VIN&#9;YARD&#9;OUT" spellcheck="false"></textarea>
      <div id="bulk-result"></div>
      <div class="actions"><button type="button" class="btn" data-act="close-modal">Close</button><button class="btn" type="submit">Check rows</button><button type="button" class="btn primary" id="bulk-apply" disabled>Apply</button></div>
    </form>`);
  let rows = [];
  const show = r => {
    const errs = r.errors.map(e => `<tr><td class="num">${e.row}</td><td class="mono">${esc(e.vin)}</td><td style="white-space:normal">${esc(e.message)}</td></tr>`).join('');
    $('#bulk-result').innerHTML = `<div class="${r.dryRun ? 'okbox' : 'okbox'}">${r.dryRun ? 'Check result' : 'Applied'}: <b>${fmt(r.created)}</b> new, <b>${fmt(r.updated)}</b> updated, ${fmt(r.unchanged)} unchanged${r.errors.length ? `, <b>${fmt(r.errors.length)}</b> with problems (these are skipped)` : ''}.</div>
      ${errs ? `<div class="table-wrap" style="max-height:180px;margin-top:8px"><table><thead><tr><th class="num">Row</th><th>VIN</th><th>Problem</th></tr></thead><tbody>${errs}</tbody></table></div>` : ''}`;
  };
  $('#bulk-text').addEventListener('input', () => { $('#bulk-apply').disabled = true; });
  $('#bulk-form').addEventListener('submit', async e => {
    e.preventDefault();
    rows = gridToRecords(parseGrid($('#bulk-text').value));
    if (!rows.length) { $('#bulk-result').innerHTML = '<div class="err">Nothing to check - paste some rows first.</div>'; return; }
    try { const r = await api('/api/vehicles/import', { method: 'POST', body: { rows, dryRun: true } }); show(r); $('#bulk-apply').disabled = !(r.created + r.updated); }
    catch (err) { $('#bulk-result').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
  $('#bulk-apply').addEventListener('click', async () => {
    $('#bulk-apply').disabled = true;
    try { const r = await api('/api/vehicles/import', { method: 'POST', body: { rows, dryRun: false } }); show(r); toast(`${fmt(r.created)} added, ${fmt(r.updated)} updated`); await loadOptions(); go(S.view); }
    catch (err) { $('#bulk-result').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ users (admin)
let userRows = [];
async function renderUsers() {
  userRows = (await api('/api/users')).users;
  $('#view').innerHTML = `<h1>Users</h1><p class="sub">Admins see everything and can add, update and delete. Handlers see everything and can add and update. Customers only see units under their Customer Name.</p>
    <section class="card"><div class="toolbar"><span class="muted">${userRows.length} logins</span><span class="grow"></span><button class="btn primary" data-act="add-user">+ Add user</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Customer Name</th><th>Created</th><th></th></tr></thead><tbody>
    ${userRows.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><span class="role">${esc(u.role)}</span></td><td>${esc(u.customer_name || '')}</td><td>${esc((u.created_at || '').slice(0, 10))}</td>
      <td><button class="btn small" data-act="edit-user" data-id="${u.id}">Edit</button>${u.id !== S.user.id ? ` <button class="btn small danger" data-act="delete-user" data-id="${u.id}">Delete</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></section>`;
}
function userForm(u) {
  const edit = !!u; u = u || { role: 'customer' };
  openModal(`<h2>${edit ? 'Edit user' : 'Add user'}</h2>
    <form class="form" id="user-form" data-id="${edit ? u.id : ''}">
      <div class="two"><div class="f"><label for="u-name" class="req">Name</label><input id="u-name" name="name" value="${esc(u.name || '')}" required></div>
        <div class="f"><label for="u-email" class="req">Email</label><input id="u-email" name="email" type="email" value="${esc(u.email || '')}" required autocomplete="off"></div></div>
      <div class="two"><div class="f"><label for="u-role" class="req">Role</label><select id="u-role" name="role">
          ${['admin', 'handler', 'customer'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></div>
        <div class="f" id="u-cust-wrap"><label for="u-cust" class="req">Customer Name</label><input id="u-cust" name="customer_name" value="${esc(u.customer_name || '')}" list="dl-ucust"><datalist id="dl-ucust">${S.options.customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div></div>
      <div class="f"><label for="u-pass" class="${edit ? '' : 'req'}">${edit ? 'New password (leave blank to keep the current one)' : 'Password (min 8 characters)'}</label><input id="u-pass" name="password" type="password" autocomplete="new-password" minlength="8" ${edit ? '' : 'required'}></div>
      <p class="hint">Customer Name must match the Customer Name on the vehicle records exactly (e.g. AWR) - that is what limits what the customer can see.</p>
      <div id="u-err"></div>
      <div class="actions"><button type="button" class="btn" data-act="close-modal">Cancel</button><button class="btn primary" type="submit">${edit ? 'Save changes' : 'Add user'}</button></div>
    </form>`);
  const sync = () => { $('#u-cust-wrap').style.display = $('#u-role').value === 'customer' ? '' : 'none'; };
  $('#u-role').addEventListener('change', sync); sync();
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const id = e.target.dataset.id;
    try { await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PUT' : 'POST', body }); closeModal(); toast(id ? 'User updated' : 'User added'); renderUsers(); }
    catch (err) { $('#u-err').innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  });
}

// ------------------------------------------------------------------ events
// after the make selection changes, drop ticked models that no longer belong to it
function pruneModels() {
  const mk = S.filters.make;
  if (mk.length) S.filters.model = S.filters.model.filter(m => S.options.models.some(x => x.model === m && mk.includes(x.make)));
}
// click = select only this segment (click again to clear); Ctrl/Cmd+click = add or remove it
function pick(el, additive) {
  hideTip();
  if (el.dataset.range) {
    const a = el.dataset.range + '_from', b = el.dataset.range + '_to', same = S.filters[a] === el.dataset.from && S.filters[b] === el.dataset.to;
    S.filters[a] = same ? '' : el.dataset.from; S.filters[b] = same ? '' : el.dataset.to;
  } else {
    const k = el.dataset.pick, v = el.dataset.val, cur = S.filters[k];
    if (additive) S.filters[k] = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
    else S.filters[k] = cur.length === 1 && cur[0] === v ? [] : [v];
    if (k === 'make') pruneModels();
  }
  S.page = 1; go(S.view);
}
// hover tooltip for chart segments
const tip = document.createElement('div'); tip.id = 'tip'; document.body.appendChild(tip);
function hideTip() { tip.style.display = 'none'; }
document.addEventListener('mousemove', e => {
  const t = e.target.closest ? e.target.closest('[data-tt]') : null;
  if (!t) return hideTip();
  tip.innerHTML = `<b>${esc(t.dataset.tt)}</b>${esc(t.dataset.tb)}`;
  tip.style.display = 'block';
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - w - 8) + 'px';
  tip.style.top = Math.min(e.clientY + 14, window.innerHeight - h - 8) + 'px';
});
document.addEventListener('scroll', hideTip, true);
// Dropdown filters apply as soon as a box is ticked. The page re-renders on every change,
// so the open dropdown (and its scroll position / focused box) is remembered and restored.
let msOpen = null; // { key, top, focus }
function commitMs(ms, focusValue) {
  const key = ms.dataset.ms, vals = [...ms.querySelectorAll('input:checked')].map(i => i.value);
  if (vals.join('\n') === S.filters[key].join('\n')) return;
  S.filters[key] = vals;
  if (key === 'make') pruneModels();
  msOpen = { key, top: ms.querySelector('.ms-list').scrollTop, focus: focusValue };
  S.page = 1; go(S.view);
}
function openMs(ms) {
  ms.querySelector('.ms-panel').hidden = false;
  ms.querySelector('.ms-btn').setAttribute('aria-expanded', 'true');
}
function closeMs(ms) {
  msOpen = null;
  ms.querySelector('.ms-panel').hidden = true;
  ms.querySelector('.ms-btn').setAttribute('aria-expanded', 'false');
}
function restoreMs() {
  if (!msOpen) return;
  const ms = document.querySelector(`.ms[data-ms="${msOpen.key}"]`);
  if (!ms) { msOpen = null; return; }
  openMs(ms);
  ms.querySelector('.ms-list').scrollTop = msOpen.top;
  const box = [...ms.querySelectorAll('input')].find(i => i.value === msOpen.focus) || ms.querySelector('.ms-clear');
  if (box) box.focus({ preventScroll: true });
}
document.addEventListener('click', async e => {
  const openPanel = document.querySelector('.ms-panel:not([hidden])');
  if (openPanel && openPanel.closest('.ms') !== e.target.closest('.ms')) closeMs(openPanel.closest('.ms'));
  const nav = e.target.closest('[data-nav]');
  if (nav) return go(nav.dataset.nav);
  const p = e.target.closest('[data-pick], [data-range]');
  if (p) return pick(p, e.ctrlKey || e.metaKey);
  const th = e.target.closest('th[data-sort]');
  if (th) { const k = th.dataset.sort; if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = k; S.dir = 'asc'; } S.page = 1; return renderRecords(); }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  // record ids are numbers; login ids are text
  const act = el.dataset.act, uid = el.dataset.id, id = Number(uid);
  try {
    if (act === 'logout') { S.user = null; await api('/api/logout', { method: 'POST' }); S.filters = newFilters(); S.missing = false; S.q = ''; renderLogin(); }
    else if (act === 'export') {
      el.disabled = true;
      try {
        const { csv } = await api('/api/export?' + filterQuery({ q: S.q }));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `yard-stock-${today()}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } finally { el.disabled = false; }
    }
    else if (act === 'reset-filters') { S.filters = newFilters(); S.missing = false; S.q = ''; S.page = 1; go(S.view); }
    else if (act === 'clear-f') {
      const k = el.dataset.key;
      if (k === 'out') { S.filters.out_from = ''; S.filters.out_to = ''; } else S.filters[k] = [];
      S.page = 1; go(S.view);
    }
    else if (act === 'ms-toggle') {
      const ms = el.closest('.ms'), panel = ms.querySelector('.ms-panel');
      if (!panel.hidden) return void closeMs(ms);
      openMs(ms);
      const first = panel.querySelector('input'); if (first) first.focus();
    }
    else if (act === 'ms-clear') {
      const ms = el.closest('.ms');
      ms.querySelectorAll('input:checked').forEach(i => { i.checked = false; });
      commitMs(ms);
    }
    else if (act === 'as-chart' || act === 'as-table') {
      const card = el.closest('.chart'); card.classList.toggle('show-table', act === 'as-table');
      card.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b === el));
    }
    else if (act === 'show-missing') { S.missing = true; S.page = 1; go('records'); }
    else if (act === 'clear-missing') { S.missing = false; S.page = 1; renderRecords(); }
    else if (act === 'add') vehicleForm();
    else if (act === 'edit') vehicleForm(recordRows.find(r => r.id === id));
    else if (act === 'bulk') bulkModal();
    else if (act === 'close-modal') closeModal();
    else if (act === 'delete') {
      const r = recordRows.find(x => x.id === id);
      if (r && confirm(`Delete ${r.vin} (${r.make || ''} ${r.model || ''}) permanently? This cannot be undone.`)) { await api(`/api/vehicles/${id}`, { method: 'DELETE' }); toast('Record deleted'); keepRecScroll(); await loadOptions(); renderRecords(); }
    }
    else if (act === 'add-user') userForm();
    else if (act === 'edit-user') userForm(userRows.find(u => u.id === uid));
    else if (act === 'delete-user') {
      const u = userRows.find(x => x.id === uid);
      if (u && confirm(`Delete the login for ${u.email}?`)) { await api(`/api/users/${uid}`, { method: 'DELETE' }); toast('User deleted'); renderUsers(); }
    }
  } catch (err) { toast(err.message); }
});
document.addEventListener('change', e => {
  const list = e.target.closest && e.target.closest('.ms-list');
  if (list) return commitMs(list.closest('.ms'), e.target.value);
  const k = e.target.dataset && e.target.dataset.f;
  if (!k) return;
  S.filters[k] = e.target.value;
  S.page = 1; go(S.view);
});
let searchTimer;
document.addEventListener('input', e => {
  if (e.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.q = e.target.value; S.page = 1; renderRecords(); }, 300);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const open = document.querySelector('.ms-panel:not([hidden])');
    if (open) { const ms = open.closest('.ms'); closeMs(ms); ms.querySelector('.ms-btn').focus(); }
    else closeModal();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && (e.target.dataset.pick || e.target.dataset.range)) { e.preventDefault(); pick(e.target, e.ctrlKey || e.metaKey); }
});

// ------------------------------------------------------------------ start
async function boot() {
  const me = await api('/api/me');
  if (me.needsSetup) return renderSetup();
  if (!me.user) return renderLogin();
  S.user = me.user;
  if (S.view === 'users' && !isAdmin()) S.view = 'dashboard';
  await loadOptions();
  renderShell();
  go(S.view);
}
boot().catch(e => { $('#app').innerHTML = `<div class="center"><div class="err">${esc(e.message)}</div></div>`; });
