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

create index roadmap_items_board_order_idx
  on public.roadmap_items (project_id, status, sort_order, created_at);
create index votes_roadmap_item_id_idx on public.votes (roadmap_item_id);

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

revoke all on function public.is_roadmap_admin() from public;
grant execute on function public.is_roadmap_admin() to authenticated;
revoke all on function public.roadmap_vote_count(uuid) from public;
grant execute on function public.roadmap_vote_count(uuid) to anon, authenticated, service_role;

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
revoke all on table public.roadmap_items_public from anon, authenticated;

grant select on table public.projects to anon, authenticated;
grant select on table public.roadmap_items to anon, authenticated;
grant select on table public.roadmap_items_public to anon, authenticated;
grant insert, update, delete on table public.projects to authenticated;
grant insert, update, delete on table public.roadmap_items to authenticated;

comment on table public.votes is 'Stores HMAC-SHA-256 client IP hashes; plaintext IP addresses are never persisted.';
comment on view public.roadmap_items_public is 'Public-safe roadmap items with aggregate vote counts and no vote identifiers.';
