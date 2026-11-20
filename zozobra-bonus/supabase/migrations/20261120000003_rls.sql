-- Row Level Security. Default deny: every bonus table has RLS on and the
-- anon role gets nothing. The service role (edge functions, server-side
-- recalculation) bypasses RLS by design.
-- Revokes are scoped to this app's tables only: the project may host other
-- apps whose tables must keep their own grants.

revoke all on public.branches, public.employees, public.employee_external_ids, public.metrics, public.role_metrics, public.metric_targets, public.metric_target_role_amounts, public.integrations, public.metric_source_map, public.metric_results, public.unmatched_rows, public.bonus_payouts, public.sync_log, public.audit_log, public.webhook_receipts from anon;

alter table public.branches enable row level security;
alter table public.employees enable row level security;
alter table public.employee_external_ids enable row level security;
alter table public.metrics enable row level security;
alter table public.role_metrics enable row level security;
alter table public.metric_targets enable row level security;
alter table public.metric_target_role_amounts enable row level security;
alter table public.integrations enable row level security;
alter table public.metric_source_map enable row level security;
alter table public.metric_results enable row level security;
alter table public.unmatched_rows enable row level security;
alter table public.bonus_payouts enable row level security;
alter table public.sync_log enable row level security;
alter table public.audit_log enable row level security;
alter table public.webhook_receipts enable row level security;

-- branches ----------------------------------------------------------------
create policy branches_read on public.branches for select to authenticated
  using (id = app.my_branch_id());
create policy branches_admin on public.branches for update to authenticated
  using (app.is_admin() and id = app.my_branch_id())
  with check (app.is_admin() and id = app.my_branch_id());

-- employees ---------------------------------------------------------------
-- Own row always; managers see their branch (to enter scores); admin manages.
create policy employees_self on public.employees for select to authenticated
  using (auth_user_id = auth.uid());
create policy employees_manager_read on public.employees for select to authenticated
  using (app.is_manager() and branch_id = app.my_branch_id());
create policy employees_admin_insert on public.employees for insert to authenticated
  with check (app.is_admin() and branch_id = app.my_branch_id());
create policy employees_admin_update on public.employees for update to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());

-- Nobody edits the auth link through the API; it is set by the login trigger.
revoke update on public.employees from authenticated;
grant update (first_name, last_name, phone, job_role, app_role, payroll_id, tip_based, bonus_eligible,
              start_date, end_date, active) on public.employees to authenticated;

-- An admin must not be able to lock themself out by demoting their own row.
create or replace function app.guard_self_demote() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.auth_user_id = auth.uid() and old.app_role = 'admin'
     and (new.app_role <> 'admin' or not new.active) then
    raise exception 'לא ניתן להסיר הרשאת מנהל מעצמך';
  end if;
  return new;
end $$;
create trigger employees_self_demote before update on public.employees
  for each row execute function app.guard_self_demote();

create policy external_ids_admin on public.employee_external_ids for all to authenticated
  using (app.is_admin() and exists (
    select 1 from public.employees e where e.id = employee_id and e.branch_id = app.my_branch_id()))
  with check (app.is_admin() and exists (
    select 1 from public.employees e where e.id = employee_id and e.branch_id = app.my_branch_id()));

-- metric catalog ----------------------------------------------------------
create policy metrics_read on public.metrics for select to authenticated using (true);
create policy role_metrics_read on public.role_metrics for select to authenticated using (true);
create policy role_metrics_admin on public.role_metrics for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- targets -----------------------------------------------------------------
create policy targets_read on public.metric_targets for select to authenticated
  using (branch_id = app.my_branch_id());
create policy targets_admin on public.metric_targets for all to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());

create policy role_amounts_read on public.metric_target_role_amounts for select to authenticated
  using (exists (select 1 from public.metric_targets t
                  where t.id = target_id and t.branch_id = app.my_branch_id()));
create policy role_amounts_admin on public.metric_target_role_amounts for all to authenticated
  using (app.is_admin() and exists (select 1 from public.metric_targets t
                  where t.id = target_id and t.branch_id = app.my_branch_id()))
  with check (app.is_admin() and exists (select 1 from public.metric_targets t
                  where t.id = target_id and t.branch_id = app.my_branch_id()));

-- results -----------------------------------------------------------------
-- Employee: own results + branch-level results of own branch.
create policy results_employee_read on public.metric_results for select to authenticated
  using (
    branch_id = app.my_branch_id()
    and (employee_id = app.my_employee_id() or employee_id is null or app.is_manager())
  );
-- Shift manager: manual scores only, own branch, manager-editable metrics.
create policy results_manager_insert on public.metric_results for insert to authenticated
  with check (
    app.is_manager() and branch_id = app.my_branch_id() and source = 'manual'
    and exists (select 1 from public.metrics m where m.id = metric_id and m.manager_editable)
  );
create policy results_manager_update on public.metric_results for update to authenticated
  using (
    app.is_manager() and branch_id = app.my_branch_id() and source = 'manual'
    and exists (select 1 from public.metrics m where m.id = metric_id and m.manager_editable)
  )
  with check (
    app.is_manager() and branch_id = app.my_branch_id() and source = 'manual'
    and exists (select 1 from public.metrics m where m.id = metric_id and m.manager_editable)
  );
create policy results_admin on public.metric_results for all to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());

-- payouts -----------------------------------------------------------------
create policy payouts_self on public.bonus_payouts for select to authenticated
  using (employee_id = app.my_employee_id());
create policy payouts_admin_read on public.bonus_payouts for select to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id());
-- Admin may only change status (approve / unapprove / mark paid); amounts
-- are written by the server-side recalculation (service role).
create policy payouts_admin_update on public.bonus_payouts for update to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());
revoke update on public.bonus_payouts from authenticated;
grant update (status) on public.bonus_payouts to authenticated;

-- admin-only tables -------------------------------------------------------
create policy integrations_admin on public.integrations for all to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());
revoke update on public.integrations from authenticated;
grant update (display_name, status, frequency, config) on public.integrations to authenticated;
revoke insert on public.integrations from authenticated;
grant insert (branch_id, system, display_name, status, frequency, config) on public.integrations to authenticated;

create policy source_map_admin on public.metric_source_map for all to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());
create policy unmatched_admin on public.unmatched_rows for all to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id())
  with check (app.is_admin() and branch_id = app.my_branch_id());
create policy sync_log_admin on public.sync_log for select to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id());
create policy audit_admin on public.audit_log for select to authenticated
  using (app.is_admin() and branch_id = app.my_branch_id());
-- audit_log is append-only and written only by triggers.
revoke insert, update, delete on public.audit_log from authenticated;
-- webhook_receipts: no policies → service role only.
