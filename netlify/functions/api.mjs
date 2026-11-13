// Netlify Function: every /api/* request lands here and is handled by the shared app code.
// Needs the DATABASE_URL environment variable (Supabase connection string) set in Netlify.
import { createApp } from '../../src/app.mjs';
import { pgDb } from '../../src/db-pg.mjs';

let handle; // kept between requests while the function stays warm

export default async (request, context) => {
  if (!handle) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      return new Response(JSON.stringify({ error: 'DATABASE_URL is not set in the Netlify site settings' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    handle = createApp(pgDb(url));
  }
  return handle(request, { ip: context.ip || '' });
};

export const config = { path: '/api/*' };
