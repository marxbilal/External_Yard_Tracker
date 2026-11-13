// Copies the data this PC already has (data/yard.db, else data/seed.json) into a Postgres database.
// Only fills tables that are empty, so it can never overwrite live data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELDS, normalise, insertVehicles } from './app.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function applySchema(db) {
  await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8'));
}

// source: 'auto' (yard.db if present, else seed.json) | 'seed'
export async function loadLocalData(source = 'auto') {
  const dbFile = path.join(ROOT, 'data', 'yard.db'), seedFile = path.join(ROOT, 'data', 'seed.json');
  if (source !== 'seed' && fs.existsSync(dbFile)) {
    const { DatabaseSync } = await import('node:sqlite');
    const lite = new DatabaseSync(dbFile, { readOnly: true });
    try {
      return {
        from: 'data/yard.db',
        vehicles: lite.prepare(`SELECT ${FIELDS.join(', ')}, updated_by FROM vehicles ORDER BY id`).all(),
        users: lite.prepare('SELECT name, email, pass_hash, salt, role, customer_name FROM users ORDER BY id').all(),
      };
    } finally { lite.close(); }
  }
  if (fs.existsSync(seedFile)) {
    const vehicles = JSON.parse(fs.readFileSync(seedFile, 'utf8')).map(r => normalise(r).rec).filter(r => r.vin);
    return { from: 'data/seed.json', vehicles, users: [] };
  }
  return { from: 'nothing', vehicles: [], users: [] };
}

export async function importInto(db, data) {
  const out = { vehicles: 0, users: 0, skippedVehicles: false, skippedUsers: false };
  const n = async t => (await db.query(`SELECT COUNT(*)::int n FROM ${t}`))[0].n;
  if ((await n('vehicles')) > 0) out.skippedVehicles = true;
  else if (data.vehicles.length) {
    await db.tx(async q => {
      // keep each row's own "updated by" where the old database had one
      const groups = new Map();
      for (const v of data.vehicles) { const by = v.updated_by || 'Excel import'; if (!groups.has(by)) groups.set(by, []); groups.get(by).push(v); }
      for (const [by, rows] of groups) out.vehicles += await insertVehicles(q, rows, by);
    });
  }
  if ((await n('users')) > 0) out.skippedUsers = true;
  else {
    for (const u of data.users) {
      await db.query('INSERT INTO users (name,email,pass_hash,salt,role,customer_name) VALUES (?,?,?,?,?,?)', [u.name, String(u.email).toLowerCase(), u.pass_hash, u.salt, u.role, u.customer_name || null]);
      out.users++;
    }
  }
  return out;
}
