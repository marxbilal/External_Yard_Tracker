-- Yard Stock Tracker - database tables (Postgres / Supabase).
-- Safe to run more than once. Applied automatically by: node scripts/migrate-to-supabase.mjs

create table if not exists users (
  id integer generated always as identity primary key,
  name text not null,
  email text not null,
  pass_hash text not null,
  salt text not null,
  role text not null check (role in ('admin', 'handler', 'customer')),
  customer_name text,
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists sessions (
  token_hash text primary key,
  user_id integer not null references users (id) on delete cascade,
  expires bigint not null
);

create table if not exists vehicles (
  id integer generated always as identity primary key,
  customer_name text,
  vin text not null unique,
  five_digit text,
  make text,
  model text,
  color text,
  yard text,
  bl text,
  in_date date,
  out_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists vehicles_customer_idx on vehicles (lower(customer_name));
create index if not exists vehicles_in_idx on vehicles (in_date);
create index if not exists vehicles_out_idx on vehicles (out_date);
create index if not exists vehicles_make_idx on vehicles (make);
create index if not exists vehicles_yard_idx on vehicles (yard);

create table if not exists login_fails (
  key text primary key,
  n integer not null,
  until bigint not null
);

-- Supabase exposes tables in the public schema through its own REST API. Row level security
-- with no policies blocks that route completely; the app connects as the database owner
-- (connection string), which is not affected.
alter table users enable row level security;
alter table sessions enable row level security;
alter table vehicles enable row level security;
alter table login_fails enable row level security;
