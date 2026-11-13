// One-time move of this PC's data into Supabase.
//   1. put  DATABASE_URL=postgresql://...  in a file named .env in the project folder
//   2. run  node scripts/migrate-to-supabase.mjs
// Creates the tables, then copies vehicles and logins from data/yard.db (or data/seed.json).
// It only fills empty tables, so running it twice cannot duplicate or overwrite anything.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, applySchema, loadLocalData, importInto } from '../src/import-local.mjs';
import { pgDb } from '../src/db-pg.mjs';

if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is missing. Create a .env file in the project folder containing:\n  DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-xxxx.pooler.supabase.com:6543/postgres');
  process.exit(1);
}
const db = pgDb(url);
try {
  console.log('Connecting to', new URL(url).host, '...');
  await applySchema(db);
  console.log('Tables are ready.');
  const data = await loadLocalData();
  console.log(`Found ${data.vehicles.length} vehicles and ${data.users.length} logins in ${data.from}.`);
  const r = await importInto(db, data);
  console.log(r.skippedVehicles ? 'Vehicles: Supabase already has vehicles - nothing copied.' : `Vehicles: copied ${r.vehicles}.`);
  console.log(r.skippedUsers ? 'Logins: Supabase already has logins - nothing copied.' : `Logins: copied ${r.users}.`);
  const n = async t => (await db.query(`SELECT COUNT(*)::int n FROM ${t}`))[0].n;
  console.log(`Supabase now holds ${await n('vehicles')} vehicles and ${await n('users')} logins.`);
} catch (e) {
  console.error('Migration failed:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
