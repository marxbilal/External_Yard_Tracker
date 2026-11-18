-- Yard Stock Tracker - database (Supabase / Postgres).
--
-- The browser talks to this database directly, so every access rule lives HERE:
--   * logins are Supabase Auth users; public.profiles holds each one's name, role and customer
--   * row level security on public.vehicles decides who may read / add / update / delete
--   * the screens only call the yt_* functions below
-- Safe to run more than once. Applied by: node scripts/setup-supabase.mjs

-- ============================================================ tables
create table if not exists public.vehicles (
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
create index if not exists vehicles_customer_idx on public.vehicles (lower(customer_name));
create index if not exists vehicles_in_idx on public.vehicles (in_date);
create index if not exists vehicles_out_idx on public.vehicles (out_date);
create index if not exists vehicles_make_idx on public.vehicles (make);
create index if not exists vehicles_yard_idx on public.vehicles (yard);

-- one row per login; id is the Supabase Auth user id
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in ('admin', 'handler', 'customer')),
  customer_name text,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email));

-- ============================================================ small helpers
-- "today" for days-in-yard is the yard's local date. Change the time zone here if needed.
create or replace function public.yt_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Dubai')::date $$;

create or replace function public.yt_bucket(d integer) returns text
language sql immutable as $$
  select case when d <= 7 then '0-7 days' when d <= 15 then '8-15 days' when d <= 30 then '16-30 days'
              when d <= 60 then '31-60 days' else 'Over 60 days' end
$$;

-- role / customer of the signed-in user (null when not signed in or no profile)
create or replace function public.yt_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid())
$$;
create or replace function public.yt_customer() returns text
language sql stable security definer set search_path = '' as $$
  select customer_name from public.profiles where id = (select auth.uid())
$$;

create or replace function public.yt_row(v public.vehicles) returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', v.id, 'customer_name', v.customer_name, 'vin', v.vin, 'five_digit', v.five_digit,
    'make', v.make, 'model', v.model, 'color', v.color, 'yard', v.yard, 'bl', v.bl,
    'in_date', v.in_date, 'out_date', v.out_date)
$$;

-- ============================================================ access rules
alter table public.vehicles enable row level security;
alter table public.profiles enable row level security;

revoke all on public.vehicles from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
grant select, insert, update, delete on public.vehicles to authenticated;
grant select on public.profiles to authenticated;

drop policy if exists vehicles_read on public.vehicles;
create policy vehicles_read on public.vehicles for select to authenticated using (
  (select public.yt_role()) in ('admin', 'handler')
  or ((select public.yt_role()) = 'customer' and lower(customer_name) = lower((select public.yt_customer())))
);
drop policy if exists vehicles_add on public.vehicles;
create policy vehicles_add on public.vehicles for insert to authenticated
  with check ((select public.yt_role()) in ('admin', 'handler'));
drop policy if exists vehicles_change on public.vehicles;
create policy vehicles_change on public.vehicles for update to authenticated
  using ((select public.yt_role()) in ('admin', 'handler'))
  with check ((select public.yt_role()) in ('admin', 'handler'));
drop policy if exists vehicles_remove on public.vehicles;
create policy vehicles_remove on public.vehicles for delete to authenticated
  using ((select public.yt_role()) = 'admin');

-- a login can read its own profile; all profile changes go through the admin functions
drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles for select to authenticated using (id = (select auth.uid()));

-- Every write made through the app is checked and stamped here, whatever the browser sent.
create or replace function public.yt_vehicle_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare who text;
begin
  if (select auth.uid()) is null then return new; end if;  -- database owner (setup script)
  if tg_op = 'INSERT' or new.vin is distinct from old.vin then
    if new.vin is null or new.vin !~ '^[A-Z0-9]{5,20}$' then
      raise exception 'VIN must be 5-20 letters/digits with no spaces';
    end if;
  end if;
  if tg_op = 'INSERT' and (coalesce(new.customer_name, '') = '' or coalesce(new.five_digit, '') = '' or coalesce(new.make, '') = ''
      or coalesce(new.model, '') = '' or coalesce(new.yard, '') = '' or new.in_date is null) then
    raise exception 'Customer Name, VIN, 5 Digit, Make, Model, Yard and IN date are required';
  end if;
  if tg_op = 'UPDATE' and coalesce(old.customer_name, '') <> '' and coalesce(new.customer_name, '') = '' then
    raise exception 'Customer Name is required';
  end if;
  if new.in_date is not null and new.out_date is not null and new.out_date < new.in_date then
    raise exception 'OUT date cannot be before IN date';
  end if;
  select name into who from public.profiles where id = (select auth.uid());
  new.updated_by := coalesce(who, new.updated_by);
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists yt_vehicle_guard on public.vehicles;
create trigger yt_vehicle_guard before insert or update on public.vehicles
  for each row execute function public.yt_vehicle_guard();

-- ============================================================ filters
-- f is the filter object sent by the screens:
--   customer/make/model/yard/color/status/age: lists of ticked values   (customer values lower-case)
--   in_from/in_to/out_from/out_to: YYYY-MM-DD    missing: '1'    q: ILIKE pattern
-- skip: filters to leave out. A chart leaves out its own filter so it can still draw the
-- segments that are not selected. Row level security still applies to whoever is calling.
create or replace function public.yt_rows(f jsonb, skip text[] default '{}') returns setof public.vehicles
language sql stable as $$
  select v.*
  from public.vehicles v
  where (not coalesce(f ? 'customer', false) or (select public.yt_role()) = 'customer'
         or (f -> 'customer') ? lower(coalesce(v.customer_name, '')))
    and ('make'  = any (skip) or not coalesce(f ? 'make',  false) or (f -> 'make')  ? coalesce(nullif(v.make,  ''), '(Blank)'))
    and ('model' = any (skip) or not coalesce(f ? 'model', false) or (f -> 'model') ? coalesce(nullif(v.model, ''), 'Model not given'))
    and ('yard'  = any (skip) or not coalesce(f ? 'yard',  false) or (f -> 'yard')  ? coalesce(nullif(v.yard,  ''), '(Blank)'))
    and ('color' = any (skip) or not coalesce(f ? 'color', false) or (f -> 'color') ? coalesce(nullif(v.color, ''), '(Blank)'))
    and ('status' = any (skip) or (
             (not (coalesce((f -> 'status') ? 'in', false) and not coalesce((f -> 'status') ? 'out', false)) or v.out_date is null)
         and (not (coalesce((f -> 'status') ? 'out', false) and not coalesce((f -> 'status') ? 'in', false)) or v.out_date is not null)))
    and ('in' = any (skip) or (((f ->> 'in_from') is null or v.in_date >= (f ->> 'in_from')::date)
                           and ((f ->> 'in_to')   is null or v.in_date <= (f ->> 'in_to')::date)))
    and ('out' = any (skip) or (((f ->> 'out_from') is null or v.out_date >= (f ->> 'out_from')::date)
                            and ((f ->> 'out_to')   is null or v.out_date <= (f ->> 'out_to')::date)))
    and ('age' = any (skip) or not coalesce(f ? 'age', false)
         or (v.out_date is null and v.in_date is not null and (f -> 'age') ? public.yt_bucket(public.yt_today() - v.in_date)))
    and (coalesce(f ->> 'missing', '') <> '1' or coalesce(v.model, '') = '' or coalesce(v.color, '') = '')
    and ((f ->> 'q') is null or v.vin ilike (f ->> 'q') escape '\' or v.five_digit ilike (f ->> 'q') escape '\'
         or v.bl ilike (f ->> 'q') escape '\')
$$;

-- ============================================================ read functions
-- who am I + does the first admin still have to be created
create or replace function public.yt_me() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object('id', id, 'name', name, 'email', email, 'role', role, 'customer_name', customer_name)
             from public.profiles where id = (select auth.uid())),
    'needsSetup', not exists (select 1 from public.profiles))
$$;

-- filter option lists (only what the caller may see)
create or replace function public.yt_options() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'customers', case when (select public.yt_role()) = 'customer' then jsonb_build_array((select public.yt_customer()))
      else (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct customer_name x from public.vehicles where customer_name <> '') t) end,
    'makes',  (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct make x  from public.vehicles where make  <> '') t),
    'yards',  (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct yard x  from public.vehicles where yard  <> '') t),
    'colors', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (select distinct color x from public.vehicles where color <> '') t),
    'models', (select coalesce(jsonb_agg(jsonb_build_object('make', make, 'model', model) order by model, make), '[]'::jsonb)
               from (select distinct make, model from public.vehicles where model <> '') t))
$$;

-- every dashboard number in one call
create or replace function public.yt_stats(f jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'total', count(*),
        'in_yard', count(*) filter (where out_date is null),
        'moved_out', count(*) filter (where out_date is not null),
        'avg_days_in_yard', (avg(coalesce(out_date, public.yt_today()) - in_date) filter (where out_date is null))::float8,
        'avg_days_to_exit', (avg(coalesce(out_date, public.yt_today()) - in_date) filter (where out_date is not null))::float8,
        'oldest_days', max(coalesce(out_date, public.yt_today()) - in_date) filter (where out_date is null),
        'missing', count(*) filter (where coalesce(model, '') = '' or coalesce(color, '') = ''))
      from public.yt_rows(f)),
    'byStatus', (select jsonb_build_object('in_yard', count(*) filter (where out_date is null), 'outbound', count(*) filter (where out_date is not null))
      from public.yt_rows(f, '{status}')),
    'ageing', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value)), '[]'::jsonb)
      from (select public.yt_bucket(public.yt_today() - in_date) as name, count(*) as value
            from public.yt_rows(f, '{age}') where out_date is null and in_date is not null group by 1) t),
    -- Brand and Yard also give the IN (still in yard) and OUT (OUTBOUND) counts, for the IN / OUT switch on their charts
    'byMake', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value, 'in', n_in, 'out', n_out) order by value desc, name), '[]'::jsonb)
      from (select coalesce(nullif(make, ''), '(Blank)') as name, count(*) as value,
                   count(*) filter (where out_date is null) as n_in, count(*) filter (where out_date is not null) as n_out
            from public.yt_rows(f, '{make}') group by 1) t),
    'byModel', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value, 'in', n_in, 'out', n_out) order by value desc, name), '[]'::jsonb)
      from (select coalesce(nullif(model, ''), 'Model not given') as name, count(*) as value,
                   count(*) filter (where out_date is null) as n_in, count(*) filter (where out_date is not null) as n_out
            from public.yt_rows(f, '{model}') group by 1) t),
    'byYard', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value, 'in', n_in, 'out', n_out) order by value desc, name), '[]'::jsonb)
      from (select coalesce(nullif(yard, ''), '(Blank)') as name, count(*) as value,
                   count(*) filter (where out_date is null) as n_in, count(*) filter (where out_date is not null) as n_out
            from public.yt_rows(f, '{yard}') group by 1) t),
    'byColor', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'value', value) order by value desc, name), '[]'::jsonb)
      from (select coalesce(nullif(color, ''), '(Blank)') as name, count(*) as value from public.yt_rows(f, '{color}') group by 1) t),
    'dailyIn', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d), '[]'::jsonb)
      from (select in_date as d, count(*) as n from public.yt_rows(f, '{in}') where in_date is not null group by 1) t),
    'dailyOut', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d), '[]'::jsonb)
      from (select out_date as d, count(*) as n from public.yt_rows(f, '{out}') where out_date is not null group by 1) t))
$$;

-- one batch of the records list
create or replace function public.yt_vehicles(f jsonb, page integer default 1, size integer default 50,
                                              sort text default 'in_date', dir text default 'desc') returns jsonb
language plpgsql stable as $$
declare
  n_size integer := least(greatest(coalesce(size, 50), 1), 200);
  n_page integer := greatest(coalesce(page, 1), 1);
  ord text := case
    when sort in ('customer_name', 'vin', 'five_digit', 'make', 'model', 'color', 'yard', 'bl', 'in_date', 'out_date') then quote_ident(sort)
    when sort = 'days' then '(coalesce(out_date, public.yt_today()) - in_date)'
    else 'in_date' end;
  total bigint;
  list jsonb;
begin
  select count(*) into total from public.yt_rows(f);
  execute format($q$
    select coalesce(jsonb_agg(public.yt_row(t.v) || jsonb_build_object(
             'days', coalesce((t.v).out_date, public.yt_today()) - (t.v).in_date, 'updated_by', (t.v).updated_by)), '[]'::jsonb)
    from (select v from public.yt_rows($1) v order by %s %s nulls last, id desc limit $2 offset $3) t
  $q$, ord, case when dir = 'asc' then 'asc' else 'desc' end)
  using f, n_size, (n_page - 1) * n_size into list;
  return jsonb_build_object('total', total, 'page', n_page, 'size', n_size, 'rows', list);
end $$;

-- everything that matches, for the CSV download
create or replace function public.yt_export(f jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(public.yt_row(t.v) || jsonb_build_object('days', coalesce((t.v).out_date, public.yt_today()) - (t.v).in_date)), '[]'::jsonb)
  from (select v from public.yt_rows(f) v order by in_date desc nulls last, id desc) t
$$;

create or replace function public.yt_vehicle(p_id integer) returns jsonb
language sql stable as $$ select public.yt_row(v) from public.vehicles v where v.id = p_id $$;

-- the stored rows for a list of VINs (bulk paste compares against these)
create or replace function public.yt_existing(vins jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(public.yt_row(v)), '[]'::jsonb)
  from public.vehicles v where v.vin in (select jsonb_array_elements_text(vins))
$$;

-- ============================================================ write functions
create or replace function public.yt_need(variadic roles text[]) returns void
language plpgsql stable as $$
begin
  if (select auth.uid()) is null or public.yt_role() is null then
    raise exception 'Please sign in' using errcode = '28000';
  end if;
  if not (public.yt_role() = any (roles)) then
    raise exception 'Your role is not allowed to do this' using errcode = '42501';
  end if;
end $$;

create or replace function public.yt_vehicle_add(rec jsonb) returns jsonb
language plpgsql as $$
declare new_id integer;
begin
  perform public.yt_need('admin', 'handler');
  if exists (select 1 from public.vehicles where vin = rec ->> 'vin') then
    raise exception 'VIN % already exists - update that record instead', rec ->> 'vin';
  end if;
  insert into public.vehicles (customer_name, vin, five_digit, make, model, color, yard, bl, in_date, out_date)
  select nullif(x.customer_name, ''), x.vin, nullif(x.five_digit, ''), nullif(x.make, ''), nullif(x.model, ''),
         nullif(x.color, ''), nullif(x.yard, ''), nullif(x.bl, ''), x.in_date, x.out_date
  from jsonb_to_record(rec) as x(customer_name text, vin text, five_digit text, make text, model text, color text,
                                yard text, bl text, in_date date, out_date date)
  returning id into new_id;
  return jsonb_build_object('id', new_id);
end $$;

create or replace function public.yt_vehicle_update(p_id integer, rec jsonb) returns jsonb
language plpgsql as $$
begin
  perform public.yt_need('admin', 'handler');
  if not exists (select 1 from public.vehicles where id = p_id) then raise exception 'Record not found'; end if;
  if exists (select 1 from public.vehicles where vin = rec ->> 'vin' and id <> p_id) then
    raise exception 'VIN % already exists', rec ->> 'vin';
  end if;
  update public.vehicles v set customer_name = nullif(x.customer_name, ''), vin = x.vin, five_digit = nullif(x.five_digit, ''),
         make = nullif(x.make, ''), model = nullif(x.model, ''), color = nullif(x.color, ''), yard = nullif(x.yard, ''),
         bl = nullif(x.bl, ''), in_date = x.in_date, out_date = x.out_date
  from jsonb_to_record(rec) as x(customer_name text, vin text, five_digit text, make text, model text, color text,
                                yard text, bl text, in_date date, out_date date)
  where v.id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.yt_vehicle_delete(p_id integer) returns jsonb
language plpgsql as $$
begin
  perform public.yt_need('admin');
  delete from public.vehicles where id = p_id;
  if not found then raise exception 'Record not found'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- bulk paste: new rows and changed rows in one transaction
create or replace function public.yt_apply(creates jsonb, updates jsonb) returns jsonb
language plpgsql as $$
declare n_new integer := 0; n_upd integer := 0;
begin
  perform public.yt_need('admin', 'handler');
  insert into public.vehicles (customer_name, vin, five_digit, make, model, color, yard, bl, in_date, out_date)
  select nullif(x.customer_name, ''), x.vin, nullif(x.five_digit, ''), nullif(x.make, ''), nullif(x.model, ''),
         nullif(x.color, ''), nullif(x.yard, ''), nullif(x.bl, ''), x.in_date, x.out_date
  from jsonb_to_recordset(coalesce(creates, '[]'::jsonb)) as x(customer_name text, vin text, five_digit text, make text,
       model text, color text, yard text, bl text, in_date date, out_date date)
  on conflict (vin) do nothing;
  get diagnostics n_new = row_count;
  update public.vehicles v set customer_name = nullif(x.customer_name, ''), five_digit = nullif(x.five_digit, ''),
         make = nullif(x.make, ''), model = nullif(x.model, ''), color = nullif(x.color, ''), yard = nullif(x.yard, ''),
         bl = nullif(x.bl, ''), in_date = x.in_date, out_date = x.out_date
  from jsonb_to_recordset(coalesce(updates, '[]'::jsonb)) as x(id integer, customer_name text, five_digit text, make text,
       model text, color text, yard text, bl text, in_date date, out_date date)
  where v.id = x.id;
  get diagnostics n_upd = row_count;
  return jsonb_build_object('created', n_new, 'updated', n_upd);
end $$;

-- bulk update, step 1: the records for a list of 5 Digit numbers
create or replace function public.yt_by_five(fives jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(public.yt_row(v) order by v.five_digit, v.vin), '[]'::jsonb)
  from public.vehicles v where v.five_digit in (select upper(trim(jsonb_array_elements_text(fives))))
$$;

-- bulk update, step 2: a new Yard and/or OUT date for the chosen records (empty = keep what is there)
create or replace function public.yt_bulk_update(ids jsonb, p_yard text, p_out date) returns jsonb
language plpgsql as $$
declare n integer; bad text;
begin
  perform public.yt_need('admin', 'handler');
  p_yard := nullif(trim(coalesce(p_yard, '')), '');
  if p_yard is null and p_out is null then raise exception 'Enter a new Yard or an OUT date'; end if;
  if p_out is not null then
    select string_agg(coalesce(five_digit, vin), ', ' order by five_digit) into bad from public.vehicles
      where id in (select (jsonb_array_elements_text(ids))::integer) and in_date > p_out;
    if bad is not null then raise exception 'OUT date cannot be before IN date (%)', bad; end if;
  end if;
  update public.vehicles set yard = coalesce(p_yard, yard), out_date = coalesce(p_out, out_date)
  where id in (select (jsonb_array_elements_text(ids))::integer);
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n);
end $$;

-- ============================================================ logins (admin only)
-- Creates the Supabase Auth user and its profile. Internal: not callable from the browser.
create or replace function public.yt_make_login(p_name text, p_email text, p_password text, p_role text, p_customer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gen_random_uuid();
  em text := lower(trim(coalesce(p_email, '')));
  nm text := trim(coalesce(p_name, ''));
  cust text := nullif(trim(coalesce(p_customer, '')), '');
begin
  if nm = '' then raise exception 'Name is required'; end if;
  if em !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'A valid email is required'; end if;
  if p_role is null or p_role not in ('admin', 'handler', 'customer') then raise exception 'Role must be admin, handler or customer'; end if;
  if p_role = 'customer' and cust is null then raise exception 'Customer Name is required for a customer login'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if exists (select 1 from auth.users where lower(email) = em) or exists (select 1 from public.profiles where lower(email) = em) then
    raise exception 'That email already has a login';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
      extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', nm), now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, 'email',
      jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), now(), now(), now());
  insert into public.profiles (id, name, email, role, customer_name)
  values (uid, nm, em, p_role, case when p_role = 'customer' then cust end);
  return uid;
end $$;

-- first run only: the very first login becomes the admin
create or replace function public.yt_setup(u jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  lock table public.profiles in share row exclusive mode;
  if exists (select 1 from public.profiles) then raise exception 'Setup is already complete'; end if;
  perform public.yt_make_login(u ->> 'name', u ->> 'email', u ->> 'password', 'admin', null);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.yt_users() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.yt_need('admin');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'role', role,
            'customer_name', customer_name, 'created_at', created_at::date) order by role, name), '[]'::jsonb)
          from public.profiles);
end $$;

create or replace function public.yt_user_create(u jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.yt_need('admin');
  perform public.yt_make_login(u ->> 'name', u ->> 'email', u ->> 'password', u ->> 'role', u ->> 'customer_name');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.yt_user_update(p_id uuid, u jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  old_role text;
  em text := lower(trim(coalesce(u ->> 'email', '')));
  nm text := trim(coalesce(u ->> 'name', ''));
  rl text := u ->> 'role';
  cust text := nullif(trim(coalesce(u ->> 'customer_name', '')), '');
  pw text := coalesce(u ->> 'password', '');
begin
  perform public.yt_need('admin');
  select role into old_role from public.profiles where id = p_id;
  if old_role is null then raise exception 'User not found'; end if;
  if nm = '' then raise exception 'Name is required'; end if;
  if em !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'A valid email is required'; end if;
  if rl is null or rl not in ('admin', 'handler', 'customer') then raise exception 'Role must be admin, handler or customer'; end if;
  if rl = 'customer' and cust is null then raise exception 'Customer Name is required for a customer login'; end if;
  if pw <> '' and length(pw) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  if old_role = 'admin' and rl <> 'admin' and (select count(*) from public.profiles where role = 'admin') = 1 then
    raise exception 'This is the only admin - create another admin first';
  end if;
  if exists (select 1 from public.profiles where lower(email) = em and id <> p_id)
     or exists (select 1 from auth.users where lower(email) = em and id <> p_id) then
    raise exception 'That email already has a login';
  end if;
  update public.profiles set name = nm, email = em, role = rl, customer_name = case when rl = 'customer' then cust end where id = p_id;
  update auth.users set email = em, raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', nm),
         updated_at = now() where id = p_id;
  update auth.identities set identity_data = identity_data || jsonb_build_object('email', em), updated_at = now()
   where user_id = p_id and provider = 'email';
  if pw <> '' then
    update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf', 10)) where id = p_id;
    -- sign that login out everywhere (not the admin doing the change)
    if p_id <> (select auth.uid()) then delete from auth.sessions where user_id = p_id; end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.yt_user_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare old_role text;
begin
  perform public.yt_need('admin');
  select role into old_role from public.profiles where id = p_id;
  if old_role is null then raise exception 'User not found'; end if;
  if p_id = (select auth.uid()) then raise exception 'You cannot delete your own login'; end if;
  if old_role = 'admin' and (select count(*) from public.profiles where role = 'admin') = 1 then
    raise exception 'This is the only admin';
  end if;
  delete from auth.users where id = p_id;  -- removes the profile and sessions with it
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================ who may call what
-- Supabase lets every API role run new functions by default; take that away, then allow by name.
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'yt\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- before sign-in
grant execute on function public.yt_me(), public.yt_setup(jsonb) to anon, authenticated;
-- signed in (each function checks the role itself, and row level security applies underneath)
grant execute on function
  public.yt_today(), public.yt_bucket(integer), public.yt_role(), public.yt_customer(), public.yt_row(public.vehicles),
  public.yt_rows(jsonb, text[]), public.yt_need(text[]),
  public.yt_options(), public.yt_stats(jsonb), public.yt_vehicles(jsonb, integer, integer, text, text),
  public.yt_export(jsonb), public.yt_vehicle(integer), public.yt_existing(jsonb),
  public.yt_vehicle_add(jsonb), public.yt_vehicle_update(integer, jsonb), public.yt_vehicle_delete(integer),
  public.yt_apply(jsonb, jsonb), public.yt_by_five(jsonb), public.yt_bulk_update(jsonb, text, date),
  public.yt_users(), public.yt_user_create(jsonb), public.yt_user_update(uuid, jsonb), public.yt_user_delete(uuid)
to authenticated;

-- make the API notice the new functions straight away
notify pgrst, 'reload schema';
