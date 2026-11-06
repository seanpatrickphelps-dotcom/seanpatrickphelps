-- Meals and hydration for The Training Log.
-- Additive only. Safe to run more than once. Run after
-- 20261106_train_swap_nutrition.sql if that file has not been applied yet.
--
-- Does not UPDATE, DELETE, or reseed sessions, sets, exercises, profiles,
-- or nutrition_logs. A day that already has a typed total keeps that row.
-- Meal rows, when present, are what the app adds up for the day.
--
-- Each table is per account (user_id). Row level security lets a signed-in
-- user read and write only their own rows. The API uses the service role and
-- still filters by user_id. Nothing here is tied to one workout program, so a
-- later custom plan does not have to move this food data.
--
-- Reload the API schema in Supabase if PostgREST does not see the new tables.

alter table public.profiles add column if not exists target_hydration_oz numeric;

create table if not exists public.nutrition_meals (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  log_date date not null,
  items jsonb not null default '[]'::jsonb,
  calories numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.nutrition_meals is
  'One confirmed meal. Daily food is the sum of a user''s meals on that date. Absence of rows leaves any nutrition_logs total in place.';

create index if not exists nutrition_meals_user_date on public.nutrition_meals (user_id, log_date);

create table if not exists public.hydration_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  log_date date not null,
  ounces numeric,
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

comment on table public.hydration_logs is
  'Ounces of water for one user on one date. Null target on the profile means no goal bar.';

alter table public.nutrition_meals enable row level security;
alter table public.hydration_logs enable row level security;

drop policy if exists nutrition_meals_own on public.nutrition_meals;
create policy nutrition_meals_own on public.nutrition_meals
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists hydration_logs_own on public.hydration_logs;
create policy hydration_logs_own on public.hydration_logs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.nutrition_meals to service_role, authenticated;
grant select, insert, update, delete on public.hydration_logs to service_role, authenticated;
