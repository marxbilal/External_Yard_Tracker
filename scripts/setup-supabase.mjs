// Prepares a Supabase project for the Yard Stock Tracker. Run from the project folder:
//
//     node scripts/setup-supabase.mjs
//
// It reads these lines from the .env file:
//   DATABASE_URL      the project's "Transaction pooler" connection string (with the database password)
//   SUPABASE_URL      https://xxxxxxxx.supabase.co
//   SUPABASE_KEY      the project's PUBLISHABLE key (sb_publishable_...) or legacy "anon" key
//   OLD_DATABASE_URL  optional - a previous project to copy the vehicles and logins from
//
// What it does (every step is safe to repeat):
//   1. creates / updates the tables, access rules and functions   (supabase/schema.sql)
//   2. fills an EMPTY vehicles table from OLD_DATABASE_URL, or else from data/yard.db on this PC
//   3. recreates logins that do not exist yet. Logins from the old server-based version get a
//      temporary password, written to data/temp-passwords.txt (passwords could not be carried over)
//   4. writes public/config.js so the site knows which project to talk to
//
//     node scripts/setup-supabase.mjs --drop-legacy
//   additionally removes the old server-based tables (users, sessions, login_fails) once the new
//   site is confirmed working.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const DROP_LEGACY = process.argv.includes('--drop-legacy');
const env = k => (process.env[k] || '').trim();
const stop = msg => { console.error('\nStopped: ' + msg); process.exit(1); };

if (!env('DATABASE_URL') || /\[YOUR-PASSWORD\]|PROJECTREF/.test(env('DATABASE_URL'))) stop('DATABASE_URL in .env is missing or still the placeholder.');
const sbUrl = env('SUPABASE_URL').replace(/\/+$/, ''), sbKey = env('SUPABASE_KEY');
if (sbUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(sbUrl)) stop('SUPABASE_URL should look like https://abcdefgh.supabase.co');
if (sbKey) {
  // the site is public: only a publishable / anon key may ever go into it
  let role = '';
  try { role = JSON.parse(Buffer.from(sbKey.split('.')[1] || '', 'base64url').toString()).role || ''; } catch { /* not a JWT */ }
  if (/^sb_secret_/.test(sbKey) || role === 'service_role') stop('SUPABASE_KEY is a SECRET key. Use the publishable (or "anon") key instead - the secret key must never go into a website.');
}
const ref = url => { try { return decodeURIComponent(new URL(url).username).split('.')[1] || new URL(url).hostname; } catch { return '?'; } };
if (sbUrl && ref(env('DATABASE_URL')) !== '?' && !sbUrl.includes(ref(env('DATABASE_URL'))) && /^[a-z0-9]{20}$/.test(ref(env('DATABASE_URL')))) {
  stop(`SUPABASE_URL (${sbUrl}) and DATABASE_URL (project ${ref(env('DATABASE_URL'))}) belong to different projects.`);
}

const connect = async url => { const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; };
const exists = async (c, table) => !!(await c.query('select to_regclass($1) t', [table])).rows[0].t;
const count = async (c, table) => (await c.query(`select count(*)::int n from ${table}`)).rows[0].n;
const tempPassword = () => { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(14), b => abc[b % abc.length]).join(''); };

const db = await connect(env('DATABASE_URL'));
let old = null;
try {
  console.log(`Target project: ${ref(env('DATABASE_URL'))}`);
  await db.query(fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8'));
  console.log('1. Tables, access rules and functions are in place.');

  if (env('OLD_DATABASE_URL') && env('OLD_DATABASE_URL') !== env('DATABASE_URL')) {
    old = await connect(env('OLD_DATABASE_URL'));
    console.log(`   Copying from previous project: ${ref(env('OLD_DATABASE_URL'))}`);
  }

  // ---- 2. vehicles
  if ((await count(db, 'public.vehicles')) > 0) console.log(`2. Vehicles: already ${await count(db, 'public.vehicles')} in the database - nothing copied.`);
  else {
    let rows = [], from = 'nothing';
    if (old) {
      rows = (await old.query(`select customer_name, vin, five_digit, make, model, color, yard, bl, in_date::text in_date, out_date::text out_date,
        created_at, updated_at, updated_by from public.vehicles order by id`)).rows;
      from = 'the previous project';
    } else if (fs.existsSync(path.join(ROOT, 'data', 'yard.db'))) {
      const { DatabaseSync } = await import('node:sqlite');
      const lite = new DatabaseSync(path.join(ROOT, 'data', 'yard.db'), { readOnly: true });
      try { rows = lite.prepare('SELECT customer_name, vin, five_digit, make, model, color, yard, bl, in_date, out_date, updated_by FROM vehicles ORDER BY id').all(); } finally { lite.close(); }
      rows = rows.map(r => ({ ...r, in_date: r.in_date || null, out_date: r.out_date || null, updated_by: r.updated_by || 'Excel import' }));
      from = 'data/yard.db';
    }
    await db.query('begin');
    for (let i = 0; i < rows.length; i += 2000) {
      await db.query(`insert into public.vehicles (customer_name, vin, five_digit, make, model, color, yard, bl, in_date, out_date, created_at, updated_at, updated_by)
        select customer_name, vin, five_digit, make, model, color, yard, bl, in_date, out_date, coalesce(created_at, now()), coalesce(updated_at, now()), updated_by
        from jsonb_to_recordset($1::jsonb) as x(customer_name text, vin text, five_digit text, make text, model text, color text, yard text, bl text,
          in_date date, out_date date, created_at timestamptz, updated_at timestamptz, updated_by text)
        on conflict (vin) do nothing`, [JSON.stringify(rows.slice(i, i + 2000))]);
    }
    await db.query('commit');
    console.log(`2. Vehicles: copied ${await count(db, 'public.vehicles')} of ${rows.length} from ${from}.`);
  }

  // ---- 3. logins
  const have = new Set((await db.query('select lower(email) e from public.profiles')).rows.map(r => r.e));
  let carried = 0;
  const temp = [];
  // (a) logins of an already-converted previous project: copied with their passwords
  if (old && await exists(old, 'public.profiles')) {
    const users = (await old.query(`select p.id, p.name, lower(p.email) email, p.role, p.customer_name, p.created_at, u.encrypted_password
      from public.profiles p join auth.users u on u.id = p.id order by p.created_at`)).rows;
    for (const u of users) {
      if (have.has(u.email)) continue;
      await db.query('begin');
      await db.query(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
          created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, $3, now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', $4::text), now(), now(), '', '', '', '')`, [u.id, u.email, u.encrypted_password, u.name]);
      await db.query(`insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), $1, $1::text, 'email', jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true, 'phone_verified', false), now(), now(), now())`, [u.id, u.email]);
      await db.query('insert into public.profiles (id, name, email, role, customer_name, created_at) values ($1,$2,$3,$4,$5,$6)', [u.id, u.name, u.email, u.role, u.customer_name, u.created_at]);
      await db.query('commit');
      have.add(u.email); carried++;
    }
  }
  // (b) logins of the old server-based version: same name / email / role, new temporary password
  const legacy = [];
  for (const src of [db, old]) if (src && await exists(src, 'public.users')) legacy.push(...(await src.query('select name, lower(email) email, role, customer_name from public.users order by id')).rows);
  if (!legacy.length && !old && !have.size && fs.existsSync(path.join(ROOT, 'data', 'yard.db'))) {
    const { DatabaseSync } = await import('node:sqlite');
    const lite = new DatabaseSync(path.join(ROOT, 'data', 'yard.db'), { readOnly: true });
    try { legacy.push(...lite.prepare('SELECT name, lower(email) AS email, role, customer_name FROM users ORDER BY id').all()); } finally { lite.close(); }
  }
  for (const u of legacy) {
    if (have.has(u.email)) continue;
    const pw = tempPassword();
    await db.query('select public.yt_make_login($1,$2,$3,$4,$5)', [u.name, u.email, pw, u.role, u.customer_name]);
    have.add(u.email); temp.push({ ...u, pw });
  }
  if (temp.length) {
    const file = path.join(ROOT, 'data', 'temp-passwords.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `# Temporary passwords created ${new Date().toISOString()} for project ${ref(env('DATABASE_URL'))}\r\n# Give each person theirs, then set a new one for them under Users -> Edit. Delete this file afterwards.\r\n`
      + temp.map(u => `${u.email}\t${u.role}\t${u.pw}\r\n`).join('') + '\r\n');
  }
  console.log(`3. Logins: ${have.size} in total` + (carried ? `, ${carried} copied with their passwords` : '') + (temp.length ? `, ${temp.length} recreated with a temporary password -> data/temp-passwords.txt` : '') + '.');
  if (!have.size) console.log('   No logins yet: the first person to open the site will be asked to create the admin - do that straight away.');

  // ---- 4. site config
  if (sbUrl && sbKey) {
    fs.writeFileSync(path.join(ROOT, 'public', 'config.js'), `// Which Supabase project this site talks to. Written by: node scripts/setup-supabase.mjs
// Both values are public by design (every visitor's browser receives them); the database's
// own access rules are what protect the data. Never put the database password or a
// "secret" / "service_role" key in this file.
window.YARD_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(sbUrl)},
  SUPABASE_KEY: ${JSON.stringify(sbKey)}
};
`);
    console.log('4. public/config.js written.');
  } else console.log('4. public/config.js NOT written: add SUPABASE_URL and SUPABASE_KEY to .env and run this again.');

  // ---- optional: remove the old server-based tables
  if (DROP_LEGACY) {
    if (!(await count(db, 'public.profiles'))) console.log('   --drop-legacy skipped: there are no new logins yet.');
    else { await db.query('drop table if exists public.sessions, public.login_fails, public.users'); console.log('5. Old server-based tables removed.'); }
  } else if (await exists(db, 'public.users')) console.log('   The old server-based tables are still there. Once the new site works, remove them with:  node scripts/setup-supabase.mjs --drop-legacy');
  await db.query(`notify pgrst, 'reload schema'`);
  console.log('\nDone. Next: turn off public sign-ups in Supabase (Authentication -> Sign In / Providers -> "Allow new users to sign up"), then deploy:  npx netlify-cli deploy --prod');
} catch (e) {
  try { await db.query('rollback'); } catch { /* nothing open */ }
  console.error('\nSetup failed:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
  if (old) await old.end();
}
