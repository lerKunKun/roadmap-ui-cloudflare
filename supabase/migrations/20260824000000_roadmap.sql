create extension if not exists pgcrypto;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  project_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roadmap_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'in_progress', 'completed', 'rejected')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  roadmap_item_id uuid not null references public.roadmap_items(id) on delete cascade,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (roadmap_item_id, ip_hash)
);

create table public.suggestion_rate_limits (
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  submission_count integer not null default 1 check (submission_count between 1 and 100),
  primary key (ip_hash, window_started_at)
);

create index roadmap_items_board_order_idx
  on public.roadmap_items (project_id, status, sort_order, created_at);
create index votes_roadmap_item_id_idx on public.votes (roadmap_item_id);
create index suggestion_rate_limits_window_idx
  on public.suggestion_rate_limits (window_started_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create trigger roadmap_items_set_updated_at
before update on public.roadmap_items
for each row execute function public.set_updated_at();

insert into public.projects (name, slug, project_url, sort_order)
values
  ('广告系统', 'advertising-system', null, 0),
  ('ks-alert', 'ks-alert', null, 1),
  ('模板工具', 'template-tools', null, 2),
  ('其他', 'other', null, 3)
on conflict (slug) do nothing;

create or replace function public.is_roadmap_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'email') = 'roadmap-admin@internal.invalid', false)
$$;

create or replace function public.roadmap_vote_count(target_item_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::bigint
  from public.votes
  where roadmap_item_id = target_item_id
$$;

create or replace function public.consume_suggestion_quota(
  target_ip_hash text,
  max_allowed integer default 10
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_window timestamptz := date_trunc('hour', clock_timestamp());
  quota_consumed boolean := false;
begin
  if target_ip_hash !~ '^[0-9a-f]{64}$' or max_allowed not between 1 and 100 then
    raise exception 'invalid suggestion quota input' using errcode = '22023';
  end if;

  delete from public.suggestion_rate_limits
  where ip_hash = target_ip_hash
    and window_started_at < current_window - interval '24 hours';

  insert into public.suggestion_rate_limits (ip_hash, window_started_at, submission_count)
  values (target_ip_hash, current_window, 1)
  on conflict (ip_hash, window_started_at)
  do update
    set submission_count = public.suggestion_rate_limits.submission_count + 1
    where public.suggestion_rate_limits.submission_count < max_allowed
  returning true into quota_consumed;

  return coalesce(quota_consumed, false);
end;
$$;

create or replace function public.move_roadmap_item(
  target_item_id uuid,
  target_status text,
  target_sort_order integer
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  target_project_id uuid;
  previous_status text;
  destination_count integer;
  destination_order integer;
begin
  if target_status not in ('pending', 'approved', 'in_progress', 'completed', 'rejected') then
    raise exception 'invalid roadmap status' using errcode = '22023';
  end if;

  if target_sort_order < 0 then
    raise exception 'invalid roadmap sort order' using errcode = '22023';
  end if;

  if not public.is_roadmap_admin() then
    raise exception 'roadmap admin required' using errcode = '42501';
  end if;

  select project_id, status
  into target_project_id, previous_status
  from public.roadmap_items
  where id = target_item_id;

  if not found then
    raise exception 'roadmap item not found' using errcode = 'P0002';
  end if;

  select count(*)::integer
  into destination_count
  from public.roadmap_items
  where project_id = target_project_id
    and status = target_status
    and id <> target_item_id;

  destination_order := least(target_sort_order, destination_count);

  with ordered_destination as (
    select
      id,
      (row_number() over (order by sort_order, created_at, id) - 1)::integer as position
    from public.roadmap_items
    where project_id = target_project_id
      and status = target_status
      and id <> target_item_id
  )
  update public.roadmap_items as item
  set sort_order = case
    when ordered_destination.position >= destination_order
      then ordered_destination.position + 1
    else ordered_destination.position
  end
  from ordered_destination
  where item.id = ordered_destination.id;

  if previous_status <> target_status then
    with ordered_source as (
      select
        id,
        (row_number() over (order by sort_order, created_at, id) - 1)::integer as position
      from public.roadmap_items
      where project_id = target_project_id
        and status = previous_status
        and id <> target_item_id
    )
    update public.roadmap_items as item
    set sort_order = ordered_source.position
    from ordered_source
    where item.id = ordered_source.id;
  end if;

  update public.roadmap_items
  set status = target_status,
      sort_order = destination_order
  where id = target_item_id;
end;
$$;

create or replace function public.move_project(
  target_project_id uuid,
  target_sort_order integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  project_count integer;
  destination_order integer;
begin
  if target_sort_order < 0 then
    raise exception 'invalid project sort order' using errcode = '22023';
  end if;

  if not public.is_roadmap_admin() then
    raise exception 'roadmap admin required' using errcode = '42501';
  end if;

  if not exists (select 1 from public.projects where id = target_project_id) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  select count(*)::integer
  into project_count
  from public.projects
  where id <> target_project_id;

  destination_order := least(target_sort_order, project_count);

  with ordered_projects as (
    select
      id,
      (row_number() over (order by sort_order, created_at, id) - 1)::integer as position
    from public.projects
    where id <> target_project_id
  )
  update public.projects as project
  set sort_order = case
    when ordered_projects.position >= destination_order
      then ordered_projects.position + 1
    else ordered_projects.position
  end
  from ordered_projects
  where project.id = ordered_projects.id;

  update public.projects
  set sort_order = destination_order
  where id = target_project_id;

  return destination_order;
end;
$$;

revoke all on function public.is_roadmap_admin() from public;
grant execute on function public.is_roadmap_admin() to authenticated;
revoke all on function public.roadmap_vote_count(uuid) from public;
grant execute on function public.roadmap_vote_count(uuid) to anon, authenticated, service_role;
revoke all on function public.consume_suggestion_quota(text, integer) from public;
grant execute on function public.consume_suggestion_quota(text, integer) to service_role;
revoke all on function public.move_roadmap_item(uuid, text, integer) from public;
grant execute on function public.move_roadmap_item(uuid, text, integer) to authenticated;
revoke all on function public.move_project(uuid, integer) from public;
grant execute on function public.move_project(uuid, integer) to authenticated;

create view public.roadmap_items_public
with (security_invoker = true, security_barrier = true)
as
select
  item.id,
  item.project_id,
  item.title,
  item.description,
  item.status,
  item.sort_order,
  item.created_at,
  item.updated_at,
  public.roadmap_vote_count(item.id) as vote_count
from public.roadmap_items as item;

alter table public.projects enable row level security;
alter table public.roadmap_items enable row level security;
alter table public.votes enable row level security;
alter table public.suggestion_rate_limits enable row level security;

create policy "public reads projects"
on public.projects
for select
to anon, authenticated
using (true);

create policy "public reads items"
on public.roadmap_items
for select
to anon, authenticated
using (true);

create policy "admin writes projects"
on public.projects
for all
to authenticated
using ((select public.is_roadmap_admin()))
with check ((select public.is_roadmap_admin()));

create policy "admin writes items"
on public.roadmap_items
for all
to authenticated
using ((select public.is_roadmap_admin()))
with check ((select public.is_roadmap_admin()));

revoke all on table public.projects from anon, authenticated;
revoke all on table public.roadmap_items from anon, authenticated;
revoke all on table public.votes from anon, authenticated;
revoke all on table public.suggestion_rate_limits from anon, authenticated;
revoke all on table public.roadmap_items_public from anon, authenticated;

grant select on table public.projects to anon, authenticated;
grant select on table public.roadmap_items to anon, authenticated;
grant select on table public.roadmap_items_public to anon, authenticated;
grant insert, update, delete on table public.projects to authenticated;
grant insert, update, delete on table public.roadmap_items to authenticated;
grant select on table public.projects to service_role;
grant select, insert on table public.roadmap_items to service_role;
grant insert on table public.votes to service_role;
grant select on table public.roadmap_items_public to service_role;

comment on table public.votes is 'Stores HMAC-SHA-256 client IP hashes; plaintext IP addresses are never persisted.';
comment on table public.suggestion_rate_limits is 'Stores short-lived HMAC IP quotas for anonymous suggestion abuse control; plaintext IP addresses are never persisted.';
comment on view public.roadmap_items_public is 'Public-safe roadmap items with aggregate vote counts and no vote identifiers.';
