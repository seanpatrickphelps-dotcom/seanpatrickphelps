-- One weigh-in per account per calendar day.
-- Additive only. Safe to run more than once.
--
-- Does not UPDATE, DELETE, or reseed sessions, sets, exercises, profiles,
-- nutrition_logs, nutrition_meals, hydration_logs, or session_swaps.
-- Does not copy old session bodyweights into this table, and does not invent
-- past days. The app may insert a single first weigh-in for one account when
-- that account has none, dated the America/Chicago day they open the log.
--
-- Project: accountability (hmdfosdafnrrygsctoaj). Not the sales-coach database.
-- Reload the API schema in Supabase if PostgREST does not see weigh_ins.

create table if not exists public.weigh_ins (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  log_date date not null,
  pounds numeric not null check (pounds >= 0 and pounds <= 1000),
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

comment on table public.weigh_ins is
  'One bodyweight per user per calendar date (America/Chicago for the app''s today). Saving the same day updates the row.';

create index if not exists weigh_ins_user_date on public.weigh_ins (user_id, log_date desc);

alter table public.weigh_ins enable row level security;

drop policy if exists weigh_ins_own on public.weigh_ins;
create policy weigh_ins_own on public.weigh_ins
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.weigh_ins to service_role, authenticated;
