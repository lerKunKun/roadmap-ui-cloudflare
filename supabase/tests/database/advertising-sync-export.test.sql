begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order,
  vote_baseline,
  created_at,
  updated_at
)
select
  '41000000-0000-4000-8000-000000000001'::uuid,
  id,
  '广告同步导出条目',
  '只应出现在广告系统快照中',
  'pending',
  7,
  11,
  '2026-09-01T01:00:00Z'::timestamptz,
  '2026-09-01T01:00:00Z'::timestamptz
from public.projects
where slug = 'advertising-system';

update public.roadmap_items
set status = 'approved',
    updated_at = '2026-09-01T02:00:00Z'::timestamptz
where id = '41000000-0000-4000-8000-000000000001'::uuid;

insert into public.votes (roadmap_item_id, ip_hash)
values
  ('41000000-0000-4000-8000-000000000001'::uuid, repeat('1', 64)),
  ('41000000-0000-4000-8000-000000000001'::uuid, repeat('2', 64));

insert into public.roadmap_item_images (
  id,
  roadmap_item_id,
  storage_path,
  mime_type,
  size_bytes,
  width,
  height,
  created_at
)
values (
  '42000000-0000-4000-8000-000000000001'::uuid,
  '41000000-0000-4000-8000-000000000001'::uuid,
  'suggestions/41000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001.png',
  'image/png',
  33,
  2,
  2,
  '2026-09-01T01:30:00Z'::timestamptz
);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order
)
select
  '43000000-0000-4000-8000-000000000001'::uuid,
  id,
  '不相关项目条目',
  '不得进入广告系统快照',
  'completed',
  0
from public.projects
where slug = 'other';

select has_function(
  'public',
  'export_advertising_roadmap_snapshot',
  array[]::text[],
  'advertising export RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.export_advertising_roadmap_snapshot()',
    'execute'
  ),
  'anon cannot export the snapshot'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.export_advertising_roadmap_snapshot()',
    'execute'
  ),
  'authenticated users cannot export the snapshot'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.export_advertising_roadmap_snapshot()',
    'execute'
  ),
  'service role can export the snapshot'
);

create temporary table advertising_export_fixture as
select public.export_advertising_roadmap_snapshot() as snapshot;

select is(snapshot ->> 'version', '1', 'snapshot contract version is one')
from advertising_export_fixture;
select is(
  snapshot #>> '{project,slug}',
  'advertising-system',
  'the fixed advertising project is exported'
)
from advertising_export_fixture;
select is(
  jsonb_array_length(snapshot -> 'items'),
  1,
  'only advertising items are exported'
)
from advertising_export_fixture;
select is(
  snapshot #>> '{items,0,id}',
  '41000000-0000-4000-8000-000000000001',
  'advertising item identity is stable'
)
from advertising_export_fixture;
select is(
  snapshot #>> '{items,0,voteBaseline}',
  '13',
  'public cumulative vote total is exported as text'
)
from advertising_export_fixture;
select is(
  jsonb_array_length(snapshot -> 'histories'),
  2,
  'all advertising status transitions are exported'
)
from advertising_export_fixture;
select is(
  jsonb_array_length(snapshot -> 'images'),
  1,
  'advertising image metadata is exported'
)
from advertising_export_fixture;
select is(
  snapshot #>> '{images,0,storagePath}',
  'suggestions/41000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001.png',
  'image paths retain stable ordering and value'
)
from advertising_export_fixture;
select ok(
  snapshot::text not like '%不相关项目条目%',
  'unrelated project data never enters the snapshot'
)
from advertising_export_fixture;
select ok(
  snapshot::text !~ '"(ip|ip_hash|votes|secret|token|auth)"[[:space:]]*:',
  'sensitive and runtime-only keys are absent'
)
from advertising_export_fixture;

select * from finish();
rollback;
