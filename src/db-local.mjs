// Embedded Postgres (PGlite) stored in a folder. Only for running the app on this PC without Supabase.
import { PGlite } from '@electric-sql/pglite';
import { numbered } from './db-pg.mjs';

export async function localDb(dir) {
  const pg = new PGlite(dir);
  await pg.waitReady;
  return {
    query: async (sql, params = []) => (await pg.query(numbered(sql), params)).rows,
    exec: sql => pg.exec(sql),
    tx: fn => pg.transaction(tx => fn(async (sql, params = []) => (await tx.query(numbered(sql), params)).rows)),
    end: () => pg.close(),
  };
}
