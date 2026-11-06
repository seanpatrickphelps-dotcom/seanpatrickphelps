-- The Training Log: session exercise swaps and daily food.
-- Additive only. Safe to run more than once.
--
-- This file does not UPDATE, DELETE, or reseed sessions, sets, exercises,
-- profiles, or exercise_templates. Existing rows are not backfilled.
-- New columns are nullable, so current workouts keep working before any new
-- data is written. Days and sessions with no food log and no swap render as
-- they do today.
--
-- Run the whole file in the Supabase SQL editor (service role), then reload
-- the API schema if PostgREST does not pick the tables up on its own
-- (Settings -> API -> Reload schema, or just wait a minute).
--
-- Room for a later phase, not built here: body-composition (weight is already
-- on sessions.bodyweight and profiles.start_bodyweight / goal_bodyweight),
-- body-fat, scale reports, and bloodwork. Add those as new tables or new
-- nullable columns. Do not reuse nutrition_logs, and do not rewrite sessions
-- or sets. Food stays one row per user per date. A scale export or a lab
-- report should be its own table keyed by user and date, with a nullable
-- link if a later screen wants to show it beside that day's food.

-- Library substitutes need a row to hang sets on, but they are not part of a
-- workout day and they are not copies of a template. Existing program rows
-- already have both values set; this only allows new rows to leave them empty.
alter table public.exercises alter column workout_day drop not null;
alter table public.exercises alter column template_id drop not null;

-- Null means "part of the seeded program". Do not backfill.
alter table public.exercises add column if not exists is_library boolean;

comment on column public.exercises.is_library is
  'True only for a substitute created so a single session can log sets against it. Null or false is the seeded program. Never used to rewrite a program row.';

-- Optional daily targets. Null means "no target", which is the current behavior.
alter table public.profiles add column if not exists target_calories numeric;
alter table public.profiles add column if not exists target_protein numeric;
alter table public.profiles add column if not exists target_carbs numeric;
alter table public.profiles add column if not exists target_fat numeric;

-- One food row per person per calendar date. Independent of sessions, so a
-- rest day can have food and a workout day can have both.
create table if not exists public.nutrition_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  log_date date not null,
  calories numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

comment on table public.nutrition_logs is
  'Manual daily totals. Absence of a row means that day has no food log.';

-- This session only: the planned exercise was performed as the replacement.
-- Deleting the row (undo) does not delete sets already logged.
-- session_id and exercise ids use the same types as the existing tables.
do $$
declare
  sid_type text;
  eid_type text;
begin
  select data_type into sid_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'sessions' and column_name = 'id';
  select data_type into eid_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'exercises' and column_name = 'id';
  if sid_type is null or eid_type is null then
    raise exception 'public.sessions.id or public.exercises.id was not found';
  end if;
  execute format($sql$
    create table if not exists public.session_swaps (
      id bigint generated always as identity primary key,
      user_id uuid not null,
      session_id %1$s not null,
      planned_exercise_id %2$s not null,
      replacement_exercise_id %2$s not null,
      created_at timestamptz not null default now(),
      unique (session_id, planned_exercise_id)
    )
  $sql$, sid_type, eid_type);
end $$;

comment on table public.session_swaps is
  'Session-level exercise replacement. Does not change the seeded program. Next session of that day reads the original exercise when no swap row exists.';

-- Foreign keys are convenient, not required. Skip them if an existing id type
-- cannot be referenced, and leave the table in place either way.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'session_swaps_session_id_fkey') then
    alter table public.session_swaps
      add constraint session_swaps_session_id_fkey
      foreign key (session_id) references public.sessions (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'session_swaps_planned_exercise_id_fkey') then
    alter table public.session_swaps
      add constraint session_swaps_planned_exercise_id_fkey
      foreign key (planned_exercise_id) references public.exercises (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'session_swaps_replacement_exercise_id_fkey') then
    alter table public.session_swaps
      add constraint session_swaps_replacement_exercise_id_fkey
      foreign key (replacement_exercise_id) references public.exercises (id);
  end if;
exception when others then
  raise notice 'session_swaps foreign keys were skipped: %', sqlerrm;
end $$;

alter table public.nutrition_logs enable row level security;
alter table public.session_swaps enable row level security;

drop policy if exists nutrition_logs_own on public.nutrition_logs;
create policy nutrition_logs_own on public.nutrition_logs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists session_swaps_own on public.session_swaps;
create policy session_swaps_own on public.session_swaps
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.nutrition_logs to service_role, authenticated;
grant select, insert, update, delete on public.session_swaps to service_role, authenticated;
