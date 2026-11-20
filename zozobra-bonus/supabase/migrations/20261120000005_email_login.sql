-- Optional email on employees, used for the owner's trial login link and as
-- a login fallback. The auth link trigger now matches phone OR email.
alter table public.employees add column if not exists email text;
create unique index if not exists employees_email_key on public.employees (lower(email)) where email is not null;

create or replace function app.link_auth_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.phone is not null and new.phone <> '' then
    update public.employees
       set auth_user_id = new.id
     where phone = regexp_replace(new.phone, '[^0-9]', '', 'g')
       and (auth_user_id is null or auth_user_id = new.id);
  end if;
  if new.email is not null and new.email <> '' then
    update public.employees
       set auth_user_id = new.id
     where lower(email) = lower(new.email)
       and auth_user_id is null;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_linked on auth.users;
create trigger on_auth_user_linked
  after insert or update of phone, email on auth.users
  for each row execute function app.link_auth_user();

grant update (email) on public.employees to authenticated;
