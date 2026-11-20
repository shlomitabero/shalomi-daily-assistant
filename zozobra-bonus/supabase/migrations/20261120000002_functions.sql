-- Helper functions, triggers and business rules enforced in the database.

-- ------------------------------------------------------- identity helpers
-- SECURITY DEFINER so RLS policies can look up the caller without recursion.
create or replace function app.me() returns public.employees
language sql stable security definer set search_path = public, pg_temp as $$
  select e.* from public.employees e
  where e.auth_user_id = auth.uid() and e.active
  limit 1
$$;

create or replace function app.my_employee_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select (app.me()).id
$$;

create or replace function app.my_branch_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select (app.me()).branch_id
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.me()).app_role = 'admin', false)
$$;

create or replace function app.is_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.me()).app_role in ('shift_manager', 'admin'), false)
$$;

grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;

-- ------------------------------------------------------------- utilities
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger employees_touch before update on public.employees
  for each row execute function app.touch_updated_at();
create trigger targets_touch before update on public.metric_targets
  for each row execute function app.touch_updated_at();
create trigger integrations_touch before update on public.integrations
  for each row execute function app.touch_updated_at();
create trigger results_touch before update on public.metric_results
  for each row execute function app.touch_updated_at();

create or replace function app.audit(
  p_action text, p_entity text, p_entity_id text, p_branch uuid,
  p_before jsonb, p_after jsonb, p_reason text default null
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.audit_log (actor, branch_id, action, entity, entity_id, before, after, reason)
  values (auth.uid(), p_branch, p_action, p_entity, p_entity_id, p_before, p_after, p_reason)
$$;

-- ---------------------------------------------- link auth user → employee
-- Employees log in with phone OTP. On first login the auth user is linked
-- to the employee row with the same phone. Unknown phones get no access.
create or replace function app.link_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.phone is not null and new.phone <> '' then
    update public.employees
       set auth_user_id = new.id
     where phone = regexp_replace(new.phone, '[^0-9]', '', 'g')
       and (auth_user_id is null or auth_user_id = new.id);
  end if;
  return new;
end $$;

create trigger on_auth_user_linked
  after insert or update of phone on auth.users
  for each row execute function app.link_auth_user();

-- ------------------------------------------------- result validation
create or replace function app.validate_result() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_scope public.metric_scope;
  v_emp_branch uuid;
begin
  select scope into v_scope from public.metrics where id = new.metric_id;
  if v_scope = 'branch' and new.employee_id is not null then
    raise exception 'מדד % הוא מדד סניפי — אין לשייך לעובד', new.metric_id;
  end if;
  if v_scope = 'employee' and new.employee_id is null then
    raise exception 'מדד % הוא מדד אישי — חובה לציין עובד', new.metric_id;
  end if;
  if new.employee_id is not null then
    select branch_id into v_emp_branch from public.employees where id = new.employee_id;
    if v_emp_branch is distinct from new.branch_id then
      raise exception 'העובד אינו שייך לסניף';
    end if;
  end if;
  if tg_op = 'INSERT' or new.value is distinct from old.value then
    new.entered_by := coalesce(auth.uid(), new.entered_by);
  end if;
  return new;
end $$;

create trigger results_validate before insert or update on public.metric_results
  for each row execute function app.validate_result();

-- ----------------------------------- approved payouts revert on change
-- Any change to a result or target after approval sends every affected
-- approved payout back to draft and writes it to the audit log.
-- Paid payouts are never touched; the change is logged for follow-up.
create or replace function app.revert_affected_payouts(
  p_branch uuid, p_period date, p_metric text, p_employee uuid, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in
    select p.* from public.bonus_payouts p
      join public.employees e on e.id = p.employee_id
     where p.branch_id = p_branch
       and p.period = p_period
       and p.status in ('approved', 'paid')
       and (p_employee is null or p.employee_id = p_employee)
       and exists (select 1 from public.role_metrics rm
                    where rm.job_role = e.job_role and rm.metric_id = p_metric)
  loop
    if r.status = 'approved' then
      -- guard_payout() writes the audit row, with this reason
      perform set_config('app.reason', p_reason, true);
      update public.bonus_payouts set status = 'draft' where id = r.id;
      perform set_config('app.reason', '', true);
    else
      perform app.audit('changed_after_paid', 'bonus_payouts', r.id::text, p_branch,
        jsonb_build_object('status', 'paid', 'amount', r.amount), null, p_reason);
    end if;
  end loop;
end $$;

create or replace function app.on_result_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.metric_results;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  perform app.audit(lower(tg_op), 'metric_results', v_row.id::text, v_row.branch_id,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  perform app.revert_affected_payouts(v_row.branch_id, v_row.period, v_row.metric_id,
    v_row.employee_id, format('שינוי תוצאה במדד %s', v_row.metric_id));
  return v_row;
end $$;

create trigger results_changed after insert or update or delete on public.metric_results
  for each row execute function app.on_result_change();

create or replace function app.on_target_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.metric_targets;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if tg_op = 'UPDATE'
     and (new.target, new.threshold_pct, new.max_amount, new.active)
         is not distinct from (old.target, old.threshold_pct, old.max_amount, old.active) then
    return new;
  end if;
  perform app.audit(lower(tg_op), 'metric_targets', v_row.id::text, v_row.branch_id,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  perform app.revert_affected_payouts(v_row.branch_id, v_row.period, v_row.metric_id, null,
    format('שינוי יעד במדד %s', v_row.metric_id));
  return v_row;
end $$;

create trigger targets_changed after insert or update or delete on public.metric_targets
  for each row execute function app.on_target_change();

-- ----------------------------------------- payout status state machine
create or replace function app.guard_payout() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'paid' and (new.amount <> old.amount or new.status <> 'paid') then
      raise exception 'בונוס ששולם נעול לשינויים';
    end if;
    if new.status <> old.status then
      if not (
        (old.status = 'draft' and new.status = 'approved') or
        (old.status = 'approved' and new.status in ('draft', 'paid'))
      ) then
        raise exception 'מעבר סטטוס לא חוקי: % → %', old.status, new.status;
      end if;
      if new.status = 'approved' then
        new.approved_by := coalesce(auth.uid(), new.approved_by);
        new.approved_at := now();
      elsif new.status = 'paid' then
        new.paid_at := now();
      elsif new.status = 'draft' then
        new.approved_by := null;
        new.approved_at := null;
      end if;
      perform app.audit(
        case new.status when 'draft' then 'payout_reverted_to_draft' else 'payout_' || new.status::text end,
        'bonus_payouts', new.id::text, new.branch_id,
        jsonb_build_object('status', old.status, 'amount', old.amount),
        jsonb_build_object('status', new.status, 'amount', new.amount),
        nullif(current_setting('app.reason', true), ''));
    elsif old.status = 'approved' and new.amount <> old.amount then
      -- recalculation produced a different amount: back to draft
      new.status := 'draft';
      new.approved_by := null;
      new.approved_at := null;
      perform app.audit('payout_reverted_to_draft', 'bonus_payouts', new.id::text, new.branch_id,
        jsonb_build_object('status', 'approved', 'amount', old.amount),
        jsonb_build_object('status', 'draft', 'amount', new.amount), 'חישוב מחדש שינה את הסכום');
    end if;
  end if;
  return new;
end $$;

create trigger payouts_guard before update on public.bonus_payouts
  for each row execute function app.guard_payout();

-- --------------------------------------------- employee / role audit
create or replace function app.on_employee_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform app.audit('insert', 'employees', new.id::text, new.branch_id, null, to_jsonb(new));
  elsif (new.app_role, new.job_role, new.active, new.phone, new.start_date, new.end_date)
        is distinct from (old.app_role, old.job_role, old.active, old.phone, old.start_date, old.end_date) then
    perform app.audit('update', 'employees', new.id::text, new.branch_id, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end $$;

create trigger employees_audit after insert or update on public.employees
  for each row execute function app.on_employee_change();

-- ------------------------------------------------------------ leaderboard
-- Employees cannot read other employees' rows; this function exposes only
-- first name, role and average achievement for the caller's branch.
create or replace function public.leaderboard(p_period date)
returns table (rank bigint, first_name text, job_role public.job_role, realization numeric, is_me boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select rank() over (order by p.realization desc nulls last),
         e.first_name, e.job_role, round(p.realization, 4),
         e.id = app.my_employee_id()
    from public.bonus_payouts p
    join public.employees e on e.id = p.employee_id
   where p.period = p_period
     and p.branch_id = app.my_branch_id()
     and p.realization is not null
   order by 1, 2
$$;
revoke all on function public.leaderboard(date) from public, anon;
grant execute on function public.leaderboard(date) to authenticated;

-- ------------------------------------------------------- vault secrets
-- Secrets live only in Supabase Vault. Admins can write them; nobody can
-- read them back through the API. Only the service role (edge functions)
-- can decrypt.
create or replace function public.set_integration_secret(p_integration uuid, p_secret text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v public.integrations;
begin
  if not app.is_admin() then raise exception 'אין הרשאה'; end if;
  select * into v from public.integrations where id = p_integration and branch_id = app.my_branch_id();
  if not found then raise exception 'חיבור לא נמצא'; end if;
  if coalesce(length(p_secret), 0) < 8 then raise exception 'מפתח קצר מדי'; end if;
  if v.secret_id is null then
    update public.integrations
       set secret_id = vault.create_secret(p_secret, 'integration_' || p_integration::text,
                                           'ZOZOBRA integration secret')
     where id = p_integration;
  else
    perform vault.update_secret(v.secret_id, p_secret);
  end if;
  perform app.audit('secret_set', 'integrations', p_integration::text, v.branch_id, null, null);
end $$;
revoke all on function public.set_integration_secret(uuid, text) from public, anon;
grant execute on function public.set_integration_secret(uuid, text) to authenticated;

-- Generates a new webhook signing secret, stores it in Vault and returns it
-- once so the admin can hand it to the sending system.
create or replace function public.rotate_webhook_secret(p_integration uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_secret text := encode(gen_random_bytes(32), 'hex');
begin
  perform public.set_integration_secret(p_integration, v_secret);
  return v_secret;
end $$;
revoke all on function public.rotate_webhook_secret(uuid) from public, anon;
grant execute on function public.rotate_webhook_secret(uuid) to authenticated;

create or replace function public.integration_secret(p_integration uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select s.decrypted_secret
    from public.integrations i
    join vault.decrypted_secrets s on s.id = i.secret_id
   where i.id = p_integration
$$;
revoke all on function public.integration_secret(uuid) from public, anon, authenticated;
grant execute on function public.integration_secret(uuid) to service_role;

-- --------------------------------------------- monthly target rollover
-- On the 1st of each month, copy last month's targets forward if the admin
-- has not set new ones yet. Payout amounts are never auto-changed.
create or replace function app.rollover_targets(p_period date default date_trunc('month', now() at time zone 'Asia/Jerusalem')::date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n int;
begin
  with src as (
    select * from public.metric_targets where period = (p_period - interval '1 month')::date
  ), ins as (
    insert into public.metric_targets (branch_id, metric_id, period, target, threshold_pct, max_amount, active)
    select branch_id, metric_id, p_period, target, threshold_pct, max_amount, active from src
    on conflict (branch_id, metric_id, period) do nothing
    returning id, branch_id, metric_id
  ), roles as (
    insert into public.metric_target_role_amounts (target_id, job_role, max_amount)
    select ins.id, ra.job_role, ra.max_amount
      from ins
      join src on src.branch_id = ins.branch_id and src.metric_id = ins.metric_id
      join public.metric_target_role_amounts ra on ra.target_id = src.id
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;
