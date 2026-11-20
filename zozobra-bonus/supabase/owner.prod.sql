-- Run once after seed.prod.sql. Replace the phone (digits, 972 prefix) and name.
insert into public.employees (branch_id, first_name, last_name, phone, job_role, app_role, bonus_eligible)
values ('00000000-0000-4000-8000-000000000001', 'שלומי', '', '972XXXXXXXXX', 'shift_manager', 'admin', false);
-- link if this phone already has a login in the project
update public.employees e set auth_user_id = u.id
  from auth.users u where u.phone = e.phone and e.auth_user_id is null;
