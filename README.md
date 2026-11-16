# Yard Stock Tracker

Web app to track every car in the yard: daily record updates, IN/OUT dates, a dashboard, and three access levels.

## How it is built

The browser talks **straight to the database**. There is no server of our own in between.

- **Screens:** `public/` (plain HTML/CSS/JS), hosted by Netlify as static files.
- **Database and logins:** Supabase (Postgres + Supabase Auth). Everything is defined in `supabase/schema.sql`.
- **Access rules live in the database**, not in the browser:
  - row level security on `vehicles` decides who may read, add, update and delete;
  - the screens call the `yt_*` database functions, each of which checks the caller's role;
  - a trigger checks every write and stamps "updated by", whatever the browser sent.

`public/config.js` holds the project URL and the **publishable** key. Both are public by design.
The database password and any `secret` / `service_role` key must never go into `public/`.

## Set up a Supabase project

1. Create the project at supabase.com. Choose a region close to the users (e.g. Southeast Asia - Singapore).
2. Copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` - **Connect** -> **Direct** -> method **Transaction pooler** (port 6543), with the database
     password in place of `[YOUR-PASSWORD]` (no brackets);
   - `SUPABASE_URL` - `https://<project-id>.supabase.co`;
   - `SUPABASE_KEY` - the **publishable** key (`sb_publishable_...`), from **Connect** or Project Settings -> API Keys;
   - `OLD_DATABASE_URL` - only when moving from another project: that project's connection string.
3. Run:

   ```
   node scripts/setup-supabase.mjs
   ```

   It creates the tables, rules and functions, copies the vehicles (from `OLD_DATABASE_URL`, else
   `data/yard.db`), recreates the logins and writes `public/config.js`. It is safe to run again.
   Logins that come from the old server-based version get a temporary password, listed in
   `data/temp-passwords.txt` on this PC (never committed).
4. In Supabase: **Authentication -> Sign In / Providers -> turn off "Allow new users to sign up"**.
   Logins are only created by an admin inside the app. (A stranger who signed up would see nothing,
   because they would have no role, but there is no reason to allow it.)

## Deploy

```
npx netlify-cli deploy --prod
```

Netlify only uploads `public/`. Run it again after any change to the screens or to `public/config.js`.
A change to `supabase/schema.sql` is applied with `node scripts/setup-supabase.mjs`.

## Preview on this PC

```
node server.js
```

Opens the same screens on http://localhost:3000, talking to the same Supabase project as the live site.

## Access levels

| Role     | Sees               | Add | Update | Delete | Manage users |
|----------|--------------------|-----|--------|--------|--------------|
| Admin    | all records        | yes | yes    | yes    | yes          |
| Handler  | all records        | yes | yes    | no     | no           |
| Customer | only their records | no  | no     | no     | no           |

A customer's **Customer Name** must match the Customer Name on the vehicle records (e.g. `AWR`; upper/lower
case does not matter). Admins add, edit and remove logins under **Users**; setting a new password there
signs that person out everywhere.

"Days in yard" uses the Dubai date. To change the time zone, edit `yt_today()` in `supabase/schema.sql`.

## Files

- `public/app.js` - the screens. `public/backend.js` - the data layer: sign-in, input checks, calls to the database functions.
- `public/config.js` - which Supabase project to use. `public/vendor/supabase.js` - Supabase's browser library (`npm run vendor` refreshes it).
- `supabase/schema.sql` - tables, access rules, functions.
- `scripts/setup-supabase.mjs` - prepares a project and moves data into it.
- `server.js` - local preview. `netlify.toml` - hosting settings and security headers.
- `legacy/server-sqlite.js` - the original single-PC version (reads `data/yard.db`); kept for reference only.
- `data/` - the original local data and any temporary-password list. Kept out of Git by `.gitignore`.
