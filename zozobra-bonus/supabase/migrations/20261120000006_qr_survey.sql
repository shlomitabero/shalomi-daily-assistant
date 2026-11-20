-- Customer survey by QR: each employee gets a personal, unguessable code.
-- Customers rate overall experience + the waiter's service (1-5); the
-- monthly averages feed the 'survey' and 'service' metrics automatically.
alter table public.employees add column if not exists survey_code text;
update public.employees
   set survey_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
 where survey_code is null;
alter table public.employees
  alter column survey_code set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
create unique index if not exists employees_survey_code_key on public.employees (survey_code);

create table if not exists public.survey_responses (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  employee_id uuid not null references public.employees(id),
  period date not null check (extract(day from period) = 1),
  overall smallint not null check (overall between 1 and 5),
  service smallint not null check (service between 1 and 5),
  comment text check (comment is null or length(comment) <= 500),
  client_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists survey_responses_emp_period on public.survey_responses (employee_id, period);
create index if not exists survey_responses_client on public.survey_responses (client_hash, created_at);

alter table public.survey_responses enable row level security;
revoke all on public.survey_responses from anon;
create policy survey_responses_admin_read on public.survey_responses for select to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id());

-- the QR survey is now the authoritative source for service too
update public.metric_source_map set system = 'survey', external_key = 'service_avg'
 where metric_id = 'service';
