# Yard Stock Tracker

Web app to track every car in the yard: daily record updates, IN/OUT dates, a dashboard, and three access levels.

- **Screens:** `public/` (plain HTML/CSS/JS) - hosted by Netlify.
- **API:** `src/app.mjs` - runs as a Netlify Function (`netlify/functions/api.mjs`).
- **Data:** Postgres on Supabase (`supabase/schema.sql`).

## Deploy: Supabase + Netlify

### 1. Supabase (database)

1. Create a project at supabase.com. Pick a region and note the database password.
2. In the project, open **Connect** and copy the **Transaction pooler** connection string (port `6543`).
3. In this folder, copy `.env.example` to `.env` and paste the string as `DATABASE_URL=...`
   with your password in place of `[YOUR-PASSWORD]`. Never commit or share `.env`.
4. Create the tables and copy the existing data (vehicles and logins) across:

   ```
   node scripts/migrate-to-supabase.mjs
   ```

   It only fills empty tables, so it is safe to run again.

### 2. Netlify (site)

Netlify needs the function, so drag-and-drop upload is not enough. Use the Netlify CLI from this folder:

```
npx netlify-cli login
npx netlify-cli init          (create a new site; no build command, publish directory "public")
npx netlify-cli env:set DATABASE_URL "paste-the-same-connection-string"
npx netlify-cli deploy --prod
```

Or connect a **private** Git repository in the Netlify dashboard and add `DATABASE_URL` under
Site configuration -> Environment variables. `netlify.toml` already holds the build settings.

Optional variable: `APP_TZ` (default `Asia/Dubai`) - the time zone used for "days in yard".

For speed, put the Supabase project and the Netlify functions region close to each other.

### 3. After deploying

- Sign in with the same email and password you use locally (logins are migrated).
- If no login exists yet, the first visitor is asked to create the admin - do that straight away.
- Add handlers and customers under **Users**.

## Run on this PC

```
node server.js
```

- With `DATABASE_URL` in `.env`: uses the same Supabase data as the live site.
- Without it: uses an offline copy in `data/pg-local` (filled once from `data/yard.db` or `data/seed.json`).

## Access levels

| Role     | Sees               | Add | Update | Delete | Manage users |
|----------|--------------------|-----|--------|--------|--------------|
| Admin    | all records        | yes | yes    | yes    | yes          |
| Handler  | all records        | yes | yes    | no     | no           |
| Customer | only their records | no  | no     | no     | no           |

The customer restriction is enforced on the server. A customer's **Customer Name** must match the
Customer Name on the vehicle records (e.g. `AWR`).

## Files

- `src/app.mjs` - all API logic (logins, roles, records, dashboard numbers, bulk paste).
- `src/db-pg.mjs` - Supabase/Postgres connection. `src/db-local.mjs` - offline embedded database.
- `src/local-server.mjs` - local runner used by `server.js`.
- `scripts/migrate-to-supabase.mjs` - one-time data move. `scripts/run-test-server.js` - throw-away test copy on port 3100.
- `legacy/server-sqlite.js` - the original single-PC version (reads `data/yard.db`); fallback only.
- `data/yard.db`, `data/seed.json` - the original local data. Kept out of Git by `.gitignore`.
