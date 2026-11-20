-- ZOZOBRA bonus app — core schema.
-- Money is integer agorot. A period is the first day of a month.

create extension if not exists pgcrypto;
create schema if not exists app;

-- ------------------------------------------------------------------ enums
create type public.job_role as enum ('waiter', 'bartender', 'cook', 'chef', 'shift_manager', 'call_center');
create type public.app_role as enum ('employee', 'shift_manager', 'admin');
create type public.metric_scope as enum ('employee', 'branch');
create type public.metric_direction as enum ('higher', 'lower');
create type public.payout_status as enum ('draft', 'approved', 'paid');
create type public.integration_system as enum
  ('manual', 'csv', 'webhook', 'tabit', 'beecomm', 'cost', 'payroll', 'pbx', 'survey');
create type public.integration_status as enum
  ('not_configured', 'awaiting_credentials', 'active', 'paused', 'error');
create type public.sync_frequency as enum ('manual', 'every_15_min', 'hourly', 'daily_0500');
create type public.sync_status as enum ('running', 'success', 'partial', 'failed');

-- --------------------------------------------------------------- branches
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  timezone text not null default 'Asia/Jerusalem',
  payroll_component_code text not null default 'BONUS', -- סמל רכיב שכר לייצוא
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------- employees
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  first_name text not null,
  last_name text not null default '',
  phone text not null unique check (phone ~ '^972[0-9]{8,9}$'), -- digits only, as Supabase Auth stores it
  job_role public.job_role not null,
  app_role public.app_role not null default 'employee',
  payroll_id text, -- מספר עובד במערכת השכר
  tip_based boolean not null default false, -- מלצרים/בר: טיפים + השלמה; הבונוס שורה נפרדת
  bonus_eligible boolean not null default true, -- false for the owner / non-bonus staff
  start_date date,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index on public.employees (branch_id);

create table public.employee_external_ids (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  system public.integration_system not null,
  external_id text not null,
  external_name text,
  created_at timestamptz not null default now(),
  unique (system, external_id)
);
create index on public.employee_external_ids (employee_id);

-- ---------------------------------------------------------------- metrics
create table public.metrics (
  id text primary key,
  name text not null,
  description text not null default '',
  scope public.metric_scope not null,
  direction public.metric_direction not null,
  default_source public.integration_system not null,
  unit text not null default '',
  manager_editable boolean not null default false, -- מנהל משמרת רשאי להזין ידנית
  sort_order int not null default 0
);

create table public.role_metrics (
  job_role public.job_role not null,
  metric_id text not null references public.metrics(id) on delete cascade,
  primary key (job_role, metric_id)
);

create table public.metric_targets (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  metric_id text not null references public.metrics(id),
  period date not null check (extract(day from period) = 1),
  target numeric not null check (target > 0),
  threshold_pct numeric not null default 90 check (threshold_pct > 0 and threshold_pct <= 100),
  max_amount integer not null check (max_amount >= 0), -- agorot
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (branch_id, metric_id, period)
);

create table public.metric_target_role_amounts (
  target_id uuid not null references public.metric_targets(id) on delete cascade,
  job_role public.job_role not null,
  max_amount integer not null check (max_amount >= 0),
  primary key (target_id, job_role)
);

-- ----------------------------------------------------------- integrations
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  system public.integration_system not null,
  display_name text not null,
  status public.integration_status not null default 'not_configured',
  frequency public.sync_frequency not null default 'manual',
  config jsonb not null default '{}'::jsonb, -- non-secret settings only
  secret_id uuid, -- Supabase Vault id; the secret itself never leaves the DB/edge
  last_sync_at timestamptz,
  last_status public.sync_status,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, system)
);

-- Which source is authoritative for each metric, and what the source calls it.
create table public.metric_source_map (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  metric_id text not null references public.metrics(id),
  system public.integration_system not null,
  external_key text not null, -- e.g. Tabit report column / PBX KPI name
  unique (branch_id, metric_id),
  unique (branch_id, system, external_key)
);

-- ---------------------------------------------------------------- results
create table public.metric_results (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  period date not null check (extract(day from period) = 1),
  metric_id text not null references public.metrics(id),
  employee_id uuid references public.employees(id), -- null = branch-level metric
  value numeric not null,
  source public.integration_system not null,
  integration_id uuid references public.integrations(id) on delete set null,
  note text,
  entered_by uuid, -- auth user for manual/csv entries
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (branch_id, period, metric_id, employee_id)
);
create index on public.metric_results (branch_id, period);
create index on public.metric_results (employee_id, period);

-- Rows from an import/sync whose person could not be matched to an employee.
create table public.unmatched_rows (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  system public.integration_system not null,
  period date not null,
  external_id text,
  external_name text,
  metric_id text not null references public.metrics(id),
  value numeric not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_employee_id uuid references public.employees(id)
);
create index on public.unmatched_rows (branch_id) where resolved_at is null;

-- ---------------------------------------------------------------- payouts
create table public.bonus_payouts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  period date not null check (extract(day from period) = 1),
  employee_id uuid not null references public.employees(id),
  amount integer not null check (amount >= 0), -- agorot
  lines jsonb not null default '[]'::jsonb, -- calculation snapshot
  avg_achievement numeric,
  realization numeric, -- earned ÷ full (100%) bonus — leaderboard ranking
  missing_metrics text[] not null default '{}',
  status public.payout_status not null default 'draft',
  approved_by uuid,
  approved_at timestamptz,
  paid_at timestamptz,
  calculated_at timestamptz not null default now(),
  unique (period, employee_id)
);
create index on public.bonus_payouts (branch_id, period);

-- ------------------------------------------------------------------- logs
create table public.sync_log (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  integration_id uuid references public.integrations(id) on delete set null,
  system public.integration_system not null,
  trigger text not null check (trigger in ('cron', 'manual', 'webhook', 'csv')),
  period date,
  status public.sync_status not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_received int not null default 0,
  rows_written int not null default 0,
  rows_unmatched int not null default 0,
  rows_rejected int not null default 0,
  message text,
  details jsonb
);
create index on public.sync_log (branch_id, started_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid, -- auth.users id, null = system
  branch_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text
);
create index on public.audit_log (at desc);

create table public.webhook_receipts (
  signature text primary key,
  integration_id uuid not null references public.integrations(id) on delete cascade,
  received_at timestamptz not null default now()
);
