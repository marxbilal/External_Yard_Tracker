// Postgres connection (Supabase). Used by the Netlify function and, when DATABASE_URL is set, locally.
import pg from 'pg';

// the app writes SQL with ? placeholders; Postgres wants $1, $2, ...
export const numbered = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

export function pgDb(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  // an idle connection dropped by the pooler must not crash the process
  pool.on('error', () => {});
  // opening a connection can fail transiently (pooler restart, cold network): try once more.
  // Only the connect step is retried - a statement is never sent twice.
  const connect = async () => {
    try { return await pool.connect(); }
    catch { await new Promise(r => setTimeout(r, 300)); return pool.connect(); }
  };
  return {
    async query(sql, params = []) {
      const c = await connect();
      try { return (await c.query(numbered(sql), params)).rows; } finally { c.release(); }
    },
    async exec(sql) {
      const c = await connect();
      try { await c.query(sql); } finally { c.release(); }
    },
    async tx(fn) {
      const c = await connect();
      try {
        await c.query('BEGIN');
        const r = await fn(async (sql, params = []) => (await c.query(numbered(sql), params)).rows);
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    end: () => pool.end(),
  };
}
