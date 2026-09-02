begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(26);

insert into public.roadmap_clone_import_markers (
  singleton,
  source_project_ref,
  target_project_ref,
  manifest_digest,
  object_digest,
  dataset_digests,
  app_commit,
  captured_at,
  counts
)
values (
  true,
  'abcdefghijklmnopqrst',
  'bcdefghijklmnopqrstu',
  repeat('a', 64),
  repeat('b', 64),
  '{}'::jsonb,
  repeat('c', 40),
  '2026-09-01T00:00:00Z',
  '{}'::jsonb
)
on conflict (singleton) do update
set target_project_ref = excluded.target_project_ref;

insert into public.roadmap_items (id, project_id, title, status, sort_order)
select
  '71000000-0000-4000-8000-000000000001'::uuid,
  id,
  'Task 本地广告建议',
  'pending',
  0
from public.projects
where slug = 'advertising-system';

insert into public.votes (roadmap_item_id, ip_hash)
values ('71000000-0000-4000-8000-000000000001', repeat('1', 64));

insert into public.roadmap_item_images (
  id, roadmap_item_id, storage_path, mime_type,
  size_bytes, width, height, created_at
)
values (
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  'suggestions/71000000-0000-4000-8000-000000000001/72000000-0000-4000-8000-000000000001.png',
  'image/png', 33, 2, 2, '2026-09-01T00:00:00Z'
);

insert into public.projects (id, name, slug, sort_order)
values ('73000000-0000-4000-8000-000000000001', 'Task 哨兵', 'task-sentinel', 99);
insert into public.roadmap_items (id, project_id, title, status, sort_order)
values (
  '74000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  '哨兵条目', 'approved', 0
);
insert into public.votes (roadmap_item_id, ip_hash)
values ('74000000-0000-4000-8000-000000000001', repeat('2', 64));
insert into public.roadmap_item_images (
  id, roadmap_item_id, storage_path, mime_type,
  size_bytes, width, height, created_at
)
values (
  '75000000-0000-4000-8000-000000000001',
  '74000000-0000-4000-8000-000000000001',
  'suggestions/74000000-0000-4000-8000-000000000001/75000000-0000-4000-8000-000000000001.png',
  'image/png', 33, 2, 2, '2026-09-01T00:00:00Z'
);

create temporary table advertising_payload as
select jsonb_build_object(
  'version', 1,
  'capturedAt', '2026-09-02T00:00:00.000Z',
  'project', jsonb_build_object(
    'id', '61000000-0000-4000-8000-000000000001',
    'name', '广告系统',
    'slug', 'advertising-system',
    'projectUrl', 'https://ads.example.com',
    'sortOrder', 0,
    'createdAt', '2026-08-24T00:00:00.000Z',
    'updatedAt', '2026-09-02T00:00:00.000Z'
  ),
  'items', jsonb_build_array(jsonb_build_object(
    'id', '62000000-0000-4000-8000-000000000001',
    'projectId', '61000000-0000-4000-8000-000000000001',
    'title', '源广告条目',
    'description', '严格镜像数据',
    'status', 'approved',
    'sortOrder', 0,
    'createdAt', '2026-08-25T00:00:00.000Z',
    'updatedAt', '2026-09-01T00:00:00.000Z',
    'voteBaseline', '18'
  )),
  'histories', jsonb_build_array(jsonb_build_object(
    'sourceOrder', '1',
    'roadmapItemId', '62000000-0000-4000-8000-000000000001',
    'fromStatus', null,
    'toStatus', 'approved',
    'changedAt', '2026-08-25T00:00:00.000Z'
  )),
  'images', jsonb_build_array(jsonb_build_object(
    'id', '63000000-0000-4000-8000-000000000001',
    'roadmapItemId', '62000000-0000-4000-8000-000000000001',
    'storagePath', 'suggestions/62000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.png',
    'mimeType', 'image/png',
    'sizeBytes', 33,
    'width', 2,
    'height', 2,
    'createdAt', '2026-08-25T00:01:00.000Z',
    'sha256', repeat('d', 64)
  ))
) as snapshot;

select has_table(
  'public', 'roadmap_advertising_sync_state', 'sync state table exists'
);
select has_table(
  'public', 'roadmap_advertising_sync_object_cleanup', 'cleanup queue exists'
);
select has_function(
  'public', 'apply_advertising_roadmap_snapshot',
  array['uuid', 'jsonb', 'text', 'integer'], 'strict apply RPC exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.apply_advertising_roadmap_snapshot(uuid, jsonb, text, integer)',
    'execute'
  ),
  'anon cannot apply a snapshot'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_advertising_roadmap_snapshot(uuid, jsonb, text, integer)',
    'execute'
  ),
  'authenticated users cannot apply a snapshot'
);

select is(
  public.claim_advertising_roadmap_sync(
    '81000000-0000-4000-8000-000000000001'
  ),
  true,
  'first run claims the lease'
);
select is(
  (
    select result ->> 'applied'
    from public.apply_advertising_roadmap_snapshot(
      '81000000-0000-4000-8000-000000000001',
      (select snapshot from advertising_payload),
      repeat('e', 64),
      100
    ) as result
  ),
  'true',
  'valid source snapshot is applied'
);
select is(
  (select id from public.projects where slug = 'advertising-system'),
  '61000000-0000-4000-8000-000000000001'::uuid,
  'advertising project identity mirrors source'
);
select is(
  (select count(*) from public.roadmap_items where project_id = '61000000-0000-4000-8000-000000000001'),
  1::bigint,
  'advertising items are strictly replaced'
);
select is(
  public.roadmap_vote_count('62000000-0000-4000-8000-000000000001'),
  18::bigint,
  'source public votes become the target baseline'
);
select is(
  (select count(*) from public.votes where roadmap_item_id = '62000000-0000-4000-8000-000000000001'),
  0::bigint,
  'target advertising runtime votes remain empty'
);
select is(
  (select count(*) from public.roadmap_status_history where roadmap_item_id = '62000000-0000-4000-8000-000000000001'),
  1::bigint,
  'source history replaces trigger-generated history'
);
select is(
  (select storage_path from public.roadmap_item_images where roadmap_item_id = '62000000-0000-4000-8000-000000000001'),
  'suggestions/62000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.png',
  'source image metadata is mirrored'
);
select is(
  (select count(*) from public.roadmap_advertising_sync_object_cleanup where storage_path like 'suggestions/71000000%'),
  1::bigint,
  'old advertising object is queued for cleanup'
);
select is(
  (select title from public.roadmap_items where id = '74000000-0000-4000-8000-000000000001'),
  '哨兵条目',
  'unrelated Task item is unchanged'
);
select is(
  (select count(*) from public.votes where roadmap_item_id = '74000000-0000-4000-8000-000000000001'),
  1::bigint,
  'unrelated Task vote is unchanged'
);
select is(
  (select count(*) from public.roadmap_item_images where id = '75000000-0000-4000-8000-000000000001'),
  1::bigint,
  'unrelated Task image metadata is unchanged'
);

select lives_ok(
  $$select public.confirm_advertising_object_cleanup(array[
    'suggestions/71000000-0000-4000-8000-000000000001/72000000-0000-4000-8000-000000000001.png'
  ])$$,
  'old object cleanup can be confirmed'
);
select is(
  (select count(*) from public.roadmap_advertising_sync_object_cleanup),
  0::bigint,
  'confirmed old object leaves the cleanup queue'
);

select is(
  public.claim_advertising_roadmap_sync(
    '81000000-0000-4000-8000-000000000002'
  ),
  true,
  'a new run claims the released lease'
);
select is(
  public.claim_advertising_roadmap_sync(
    '81000000-0000-4000-8000-000000000003'
  ),
  false,
  'a concurrent run cannot replace a live lease'
);
select throws_ok(
  $$select public.apply_advertising_roadmap_snapshot(
    '81000000-0000-4000-8000-000000000002',
    jsonb_set(
      (select snapshot from advertising_payload),
      '{project,slug}',
      '"other"'::jsonb
    ),
    repeat('f', 64),
    1
  )$$,
  '22023',
  'advertising_sync_payload_invalid',
  'a payload cannot select another slug'
);
select lives_ok(
  $$select public.fail_advertising_roadmap_sync(
    '81000000-0000-4000-8000-000000000002',
    'SNAPSHOT_INVALID',
    'safe failure',
    1
  )$$,
  'failure state can release its matching lease'
);
select is(
  public.claim_advertising_roadmap_sync(
    '81000000-0000-4000-8000-000000000004'
  ),
  true,
  'failure releases only its own lease'
);
select throws_ok(
  $$select public.apply_advertising_roadmap_snapshot(
    '81000000-0000-4000-8000-000000000004',
    jsonb_set(
      (select snapshot from advertising_payload),
      '{items,0,id}',
      '"74000000-0000-4000-8000-000000000001"'::jsonb
    ),
    repeat('1', 64),
    1
  )$$,
  '23505',
  'advertising_sync_target_uuid_conflict',
  'source UUIDs cannot collide with unrelated Task data'
);
select is(
  (select last_snapshot_digest from public.roadmap_advertising_sync_state where singleton),
  repeat('e', 64),
  'failed replacements retain the last successful digest'
);

select * from finish();
rollback;
