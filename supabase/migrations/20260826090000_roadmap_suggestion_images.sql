insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'roadmap-images',
  'roadmap-images',
  false,
  5000000,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.roadmap_image_storage_usage (
  singleton boolean primary key default true check (singleton),
  used_bytes bigint not null default 0
    check (used_bytes between 0 and 900000000)
);

insert into public.roadmap_image_storage_usage (singleton, used_bytes)
values (true, 0);

create table public.roadmap_item_images (
  id uuid primary key,
  roadmap_item_id uuid not null unique
    references public.roadmap_items(id) on delete cascade,
  storage_path text not null unique
    check (storage_path ~ '^suggestions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png)$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes < 5000000),
  width integer not null check (width between 1 and 12000),
  height integer not null check (height between 1 and 12000),
  created_at timestamptz not null default now(),
  check (width::bigint * height::bigint <= 40000000)
);

create table public.suggestion_image_rate_limits (
  id bigint generated always as identity primary key,
  ip_hash text not null check (length(ip_hash) = 64),
  created_at timestamptz not null default now()
);

create index suggestion_image_rate_limits_hash_time_idx
  on public.suggestion_image_rate_limits (ip_hash, created_at desc);

create or replace function public.reserve_roadmap_image_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.roadmap_image_storage_usage
  set used_bytes = used_bytes + new.size_bytes
  where singleton
    and used_bytes + new.size_bytes <= 900000000;

  if not found then
    raise exception 'roadmap_image_storage_full' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function public.release_roadmap_image_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.roadmap_image_storage_usage
  set used_bytes = used_bytes - old.size_bytes
  where singleton
    and used_bytes >= old.size_bytes;

  if not found then
    raise exception 'roadmap_image_storage_accounting_underflow'
      using errcode = 'P0001';
  end if;

  return old;
end;
$$;

create trigger roadmap_item_images_reserve_storage
before insert on public.roadmap_item_images
for each row execute function public.reserve_roadmap_image_storage();

create trigger roadmap_item_images_release_storage
after delete on public.roadmap_item_images
for each row execute function public.release_roadmap_image_storage();

create or replace function public.consume_suggestion_image_quota(
  client_ip_hash text,
  quota_limit integer default 3
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent_count integer;
begin
  if client_ip_hash !~ '^[0-9a-f]{64}$' or quota_limit < 1 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(client_ip_hash, 0));

  delete from public.suggestion_image_rate_limits
  where created_at < now() - interval '48 hours';

  select count(*)::integer
  into recent_count
  from public.suggestion_image_rate_limits
  where ip_hash = client_ip_hash
    and created_at > now() - interval '24 hours';

  if recent_count >= quota_limit then
    return false;
  end if;

  insert into public.suggestion_image_rate_limits (ip_hash)
  values (client_ip_hash);
  return true;
end;
$$;

alter table public.roadmap_item_images enable row level security;
alter table public.roadmap_image_storage_usage enable row level security;
alter table public.suggestion_image_rate_limits enable row level security;

create policy "roadmap admins read image metadata"
on public.roadmap_item_images
for select
to authenticated
using ((select public.is_roadmap_admin()));

create policy "roadmap admins read image objects"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'roadmap-images'
  and (select public.is_roadmap_admin())
);

create policy "roadmap admins delete image objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'roadmap-images'
  and (select public.is_roadmap_admin())
);

create or replace function public.list_public_roadmap_item_images()
returns table (
  id uuid,
  storage_path text,
  mime_type text,
  size_bytes integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select image.id, image.storage_path, image.mime_type, image.size_bytes
  from public.roadmap_item_images image
  join public.roadmap_items item on item.id = image.roadmap_item_id
  where item.status in ('approved', 'in_progress', 'completed')
$$;

create or replace function public.get_roadmap_item_image_public_state(
  target_item_id uuid
)
returns table (
  has_image boolean,
  image_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.roadmap_item_images image
      where image.roadmap_item_id = target_item_id
    ) as has_image,
    (
      select image.id
      from public.roadmap_item_images image
      join public.roadmap_items item on item.id = image.roadmap_item_id
      where image.roadmap_item_id = target_item_id
        and item.status in ('approved', 'in_progress', 'completed')
    ) as image_id
$$;

create view public.roadmap_item_images_public
with (security_invoker = true, security_barrier = true)
as
select id, storage_path, mime_type, size_bytes
from public.list_public_roadmap_item_images();

drop view public.roadmap_items_public;

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
  public.roadmap_vote_count(item.id) as vote_count,
  image_state.has_image,
  image_state.image_id
from public.roadmap_items as item
cross join lateral public.get_roadmap_item_image_public_state(item.id) as image_state;

revoke all on function public.reserve_roadmap_image_storage() from public, anon, authenticated;
revoke all on function public.release_roadmap_image_storage() from public, anon, authenticated;
revoke all on function public.consume_suggestion_image_quota(text, integer) from public, anon, authenticated;
grant execute on function public.consume_suggestion_image_quota(text, integer) to service_role;

revoke all on function public.list_public_roadmap_item_images() from public;
grant execute on function public.list_public_roadmap_item_images()
  to anon, authenticated, service_role;
revoke all on function public.get_roadmap_item_image_public_state(uuid) from public;
grant execute on function public.get_roadmap_item_image_public_state(uuid)
  to anon, authenticated, service_role;

revoke all on table public.roadmap_item_images
  from anon, authenticated, service_role;
revoke all on table public.roadmap_image_storage_usage
  from anon, authenticated, service_role;
revoke all on table public.suggestion_image_rate_limits
  from anon, authenticated, service_role;
revoke all on table public.roadmap_item_images_public
  from anon, authenticated, service_role;
revoke all on table public.roadmap_items_public
  from anon, authenticated, service_role;

grant select on table public.roadmap_item_images to authenticated;
grant select, insert, delete on table public.roadmap_item_images to service_role;
grant select on table public.roadmap_item_images_public
  to anon, authenticated, service_role;
grant select on table public.roadmap_items_public
  to anon, authenticated, service_role;

grant select, delete on table storage.objects to authenticated;

comment on table public.roadmap_item_images is
  'Private Roadmap suggestion image metadata with logical storage accounting.';
comment on table public.roadmap_image_storage_usage is
  'Singleton logical byte counter for private Roadmap suggestion images.';
comment on table public.suggestion_image_rate_limits is
  'Rolling image-upload quota events keyed only by HMAC client IP hashes.';
comment on view public.roadmap_item_images_public is
  'Public-safe metadata for images whose current Roadmap status permits display.';
comment on view public.roadmap_items_public is
  'Public-safe roadmap items with aggregate vote counts and no vote identifiers.';
