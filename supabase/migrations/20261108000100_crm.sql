begin;

create schema if not exists crm_private;
revoke all on schema crm_private from public;
grant usage on schema crm_private to authenticated;

create type public.crm_role as enum ('manager', 'worker');
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'revision');

create table public.profiles (
  id uuid primary key references auth.users(id),
  name text not null check (length(trim(name)) between 1 and 120),
  role public.crm_role not null
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 150),
  address text not null check (length(trim(address)) between 1 and 300),
  archived_at timestamptz
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id),
  title text not null check (length(trim(title)) between 1 and 150),
  description text not null default '' check (length(description) <= 5000),
  assignee_id uuid not null references public.profiles(id),
  author_id uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  status public.task_status not null default 'new',
  archived_at timestamptz
);

create table public.task_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id),
  actor_id uuid not null references public.profiles(id),
  happened_at timestamptz not null default clock_timestamp(),
  from_status public.task_status,
  to_status public.task_status not null,
  comment text
);

create index tasks_site_assignee_idx on public.tasks(site_id, assignee_id) where archived_at is null;
create index tasks_assignee_idx on public.tasks(assignee_id) where archived_at is null;
create index task_history_task_idx on public.task_history(task_id, id);

create function crm_private.is_manager() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'manager'
  )
$$;

create function crm_private.site_is_active(target_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sites where id = target_id and archived_at is null
  )
$$;

create function crm_private.is_worker(target_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles where id = target_id and role = 'worker'
  )
$$;

revoke execute on all functions in schema crm_private from public, anon, authenticated, service_role;
grant execute on function crm_private.is_manager(), crm_private.site_is_active(uuid),
  crm_private.is_worker(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.sites enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;

revoke all on public.profiles, public.sites, public.tasks, public.task_history
  from public, anon, authenticated;
grant select on public.profiles, public.sites, public.tasks, public.task_history to authenticated;
grant insert (name, address), update (name, address) on public.sites to authenticated;
grant insert (site_id, title, description, assignee_id),
  update (site_id, title, description, assignee_id) on public.tasks to authenticated;

create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid()) or (select crm_private.is_manager())
  or exists (
    select 1 from public.tasks as visible_task
    where visible_task.author_id = profiles.id
  )
  or exists (
    select 1 from public.task_history as visible_event
    where visible_event.actor_id = profiles.id
  )
);

create policy sites_read on public.sites for select to authenticated using (
  archived_at is null and (
    (select crm_private.is_manager())
    or exists (
      select 1 from public.tasks as own_task where own_task.site_id = sites.id
    )
  )
);
create policy sites_insert on public.sites for insert to authenticated
  with check ((select crm_private.is_manager()));
create policy sites_update on public.sites for update to authenticated
  using ((select crm_private.is_manager()) and archived_at is null)
  with check ((select crm_private.is_manager()) and archived_at is null);

create policy tasks_read on public.tasks for select to authenticated using (
  archived_at is null and crm_private.site_is_active(site_id) and (
    (select crm_private.is_manager()) or assignee_id = (select auth.uid())
  )
);
create policy tasks_insert on public.tasks for insert to authenticated with check (
  (select crm_private.is_manager()) and crm_private.is_worker(assignee_id)
  and crm_private.site_is_active(site_id) and author_id = (select auth.uid()) and status = 'new'
);
create policy tasks_update on public.tasks for update to authenticated using (
  (select crm_private.is_manager()) and archived_at is null and crm_private.site_is_active(site_id)
) with check (
  (select crm_private.is_manager()) and archived_at is null
  and crm_private.site_is_active(site_id) and crm_private.is_worker(assignee_id)
);

create policy task_history_read on public.task_history for select to authenticated using (
  exists (
    select 1 from public.tasks as visible_task where visible_task.id = task_history.task_id
  )
);

create function crm_private.log_new_task() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.task_history (task_id, actor_id, to_status)
  values (new.id, new.author_id, new.status);
  return new;
end;
$$;
revoke execute on function crm_private.log_new_task() from public, anon, authenticated, service_role;

create trigger task_created after insert on public.tasks
for each row execute function crm_private.log_new_task();

create function public.transition_task(
  task_id uuid,
  next_status public.task_status,
  note text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_is_manager boolean := crm_private.is_manager();
  current_task public.tasks%rowtype;
  cleaned_note text := nullif(btrim(note, E' \t\r\n'), '');
begin
  if actor is null then
    raise exception 'Требуется вход' using errcode = '42501';
  end if;

  select t.* into current_task from public.tasks t
  where t.id = transition_task.task_id
    and t.archived_at is null and crm_private.site_is_active(t.site_id)
    and (actor_is_manager or t.assignee_id = actor)
  for update;

  if not found then
    raise exception 'Задача недоступна' using errcode = '42501';
  end if;

  if not coalesce(
    (actor_is_manager and current_task.status = 'review'
      and next_status in ('accepted', 'revision'))
    or (not actor_is_manager and current_task.assignee_id = actor and (
      (current_task.status in ('new', 'revision') and next_status = 'in_progress')
      or (current_task.status = 'in_progress' and next_status = 'review')
    )), false
  ) then
    raise exception 'Недопустимый переход статуса' using errcode = '22023';
  end if;

  if next_status = 'revision' and cleaned_note is null then
    raise exception 'Укажите причину возврата' using errcode = '22023';
  end if;
  if length(cleaned_note) > 2000 then
    raise exception 'Комментарий длиннее 2000 символов' using errcode = '22023';
  end if;

  update public.tasks set status = next_status where id = current_task.id;
  insert into public.task_history (task_id, actor_id, from_status, to_status, comment)
  values (current_task.id, actor, current_task.status, next_status, cleaned_note);
end;
$$;

create function public.archive_task(task_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not crm_private.is_manager() then
    raise exception 'Требуется роль постановщика' using errcode = '42501';
  end if;
  update public.tasks set archived_at = now()
  where id = archive_task.task_id and archived_at is null
    and crm_private.site_is_active(site_id);
  if not found then
    raise exception 'Задача недоступна' using errcode = '42501';
  end if;
end;
$$;

create function public.archive_site(site_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not crm_private.is_manager() then
    raise exception 'Требуется роль постановщика' using errcode = '42501';
  end if;
  update public.sites set archived_at = now()
  where id = archive_site.site_id and archived_at is null;
  if not found then
    raise exception 'Объект недоступен' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.transition_task(uuid, public.task_status, text),
  public.archive_task(uuid), public.archive_site(uuid) from public, anon, authenticated, service_role;
grant execute on function public.transition_task(uuid, public.task_status, text),
  public.archive_task(uuid), public.archive_site(uuid) to authenticated;

commit;
