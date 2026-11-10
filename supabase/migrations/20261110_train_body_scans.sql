-- Body composition scans for The Training Log.
-- Additive only. Safe to run more than once.
--
-- Does not drop or rewrite sessions, sets, exercises, weigh-ins, food, or
-- hydration. The profile update below sets only the new goal columns for one
-- account. It does not change start_bodyweight, goal_bodyweight, or any other
-- existing profile value.
--
-- Project: accountability (hmdfosdafnrrygsctoaj). Apply this in the Supabase
-- SQL editor, then reload the API schema if PostgREST does not see body_scans.

create extension if not exists pgcrypto;

create table if not exists public.body_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  scan_date date not null,
  source text default 'starfit',
  weight_lb numeric,
  body_fat_pct numeric,
  fat_mass_lb numeric,
  lean_mass_lb numeric,
  skeletal_muscle_lb numeric,
  muscle_lb numeric,
  body_water_lb numeric,
  protein_lb numeric,
  minerals_lb numeric,
  visceral_fat numeric,
  bmr_kcal numeric,
  bmi numeric,
  body_score numeric,
  arm_left_muscle_lb numeric,
  arm_right_muscle_lb numeric,
  trunk_muscle_lb numeric,
  leg_left_muscle_lb numeric,
  leg_right_muscle_lb numeric,
  arm_left_fat_lb numeric,
  arm_right_fat_lb numeric,
  trunk_fat_lb numeric,
  leg_left_fat_lb numeric,
  leg_right_fat_lb numeric,
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, scan_date)
);

comment on table public.body_scans is
  'One body composition scan per user per date. Saving the same day updates the row. The earliest scan is the baseline for recomposition progress.';

create index if not exists body_scans_user_date on public.body_scans (user_id, scan_date desc);

alter table public.body_scans enable row level security;

drop policy if exists body_scans_select on public.body_scans;
create policy body_scans_select on public.body_scans
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists body_scans_insert on public.body_scans;
create policy body_scans_insert on public.body_scans
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists body_scans_update on public.body_scans;
create policy body_scans_update on public.body_scans
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists body_scans_delete on public.body_scans;
create policy body_scans_delete on public.body_scans
  for delete to authenticated
  using (auth.uid() = user_id);

-- Default privileges on this project grant anon and authenticated ALL on new
-- tables, including TRUNCATE. RLS does not apply to TRUNCATE, so those grants
-- have to be removed. authenticated keeps row DML only.
revoke all on table public.body_scans from anon, authenticated;
grant select, insert, update, delete on table public.body_scans to authenticated;
grant select, insert, update, delete on table public.body_scans to service_role;

alter table public.profiles add column if not exists goal_body_fat_pct numeric;
alter table public.profiles add column if not exists goal_lean_mass_lb numeric;
alter table public.profiles add column if not exists goal_skeletal_muscle_lb numeric;
alter table public.profiles add column if not exists goal_arm_muscle_lb numeric;
alter table public.profiles add column if not exists goal_trunk_muscle_lb numeric;
alter table public.profiles add column if not exists goal_leg_muscle_lb numeric;
alter table public.profiles add column if not exists goal_visceral_fat numeric;

comment on column public.profiles.goal_arm_muscle_lb is 'Goal muscle per arm, pounds.';
comment on column public.profiles.goal_leg_muscle_lb is 'Goal muscle per leg, pounds.';

update public.profiles
set
  goal_body_fat_pct = 12,
  goal_lean_mass_lb = 185,
  goal_skeletal_muscle_lb = 107,
  goal_arm_muscle_lb = 11.8,
  goal_trunk_muscle_lb = 80,
  goal_leg_muscle_lb = 30.6,
  goal_visceral_fat = 6
where user_id = 'cb555240-09c4-4038-b797-3cf0b4839939';

insert into public.body_scans (
  user_id, scan_date, source,
  weight_lb, body_fat_pct, fat_mass_lb, lean_mass_lb, skeletal_muscle_lb, muscle_lb,
  body_water_lb, protein_lb, minerals_lb, visceral_fat, bmr_kcal, bmi, body_score,
  arm_left_muscle_lb, arm_right_muscle_lb, trunk_muscle_lb, leg_left_muscle_lb, leg_right_muscle_lb,
  arm_left_fat_lb, arm_right_fat_lb, trunk_fat_lb, leg_left_fat_lb, leg_right_fat_lb
) values (
  'cb555240-09c4-4038-b797-3cf0b4839939', '2026-11-05', 'starfit',
  246.0, 26.6, 65.5, 180.6, 104.5, 168.4,
  132.3, 36.2, 12.1, 12, 2139, 31.6, 78,
  10.6, 10.8, 78.9, 30.2, 30.2,
  4.2, 4.2, 35.7, 9.5, 9.5
)
on conflict (user_id, scan_date) do nothing;
