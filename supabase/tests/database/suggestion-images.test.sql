begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(63);

select has_table('public', 'roadmap_item_images', 'image metadata table exists');
select has_table('public', 'roadmap_image_storage_usage', 'image usage table exists');
select has_table('public', 'suggestion_image_rate_limits', 'image rate table exists');
select has_view('public', 'roadmap_item_images_public', 'public-safe image view exists');
select has_function(
  'public',
  'consume_suggestion_image_quota',
  array['text', 'integer'],
  'rolling image quota function exists'
);
select ok(
  (select not public from storage.buckets where id = 'roadmap-images'),
  'roadmap image bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'roadmap-images'),
  5000000::bigint,
  'bucket enforces five-million-byte platform cap'
);
select results_eq(
  $$select unnest(allowed_mime_types) from storage.buckets where id = 'roadmap-images' order by 1$$,
  $$values ('image/jpeg'::text), ('image/png'::text)$$,
  'bucket allows only JPEG and PNG'
);

select columns_are(
  'public',
  'roadmap_item_images_public',
  array['id', 'storage_path', 'mime_type', 'size_bytes'],
  'public image view exposes only cache-gateway fields'
);
select columns_are(
  'public',
  'roadmap_items_public',
  array[
    'id',
    'project_id',
    'title',
    'description',
    'status',
    'sort_order',
    'created_at',
    'updated_at',
    'vote_count',
    'has_image',
    'image_id'
  ],
  'public item view adds safe image state without a storage path'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.roadmap_item_images'::regclass),
  'image metadata enables RLS'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.roadmap_image_storage_usage'::regclass),
  'image usage enables RLS'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.suggestion_image_rate_limits'::regclass),
  'image rate limits enable RLS'
);

select ok(
  not has_table_privilege('anon', 'public.roadmap_item_images', 'select'),
  'anon cannot select image metadata directly'
);
select ok(
  not has_table_privilege('anon', 'public.roadmap_image_storage_usage', 'select'),
  'anon cannot select image usage directly'
);
select ok(
  not has_table_privilege('anon', 'public.suggestion_image_rate_limits', 'select'),
  'anon cannot select image rate limits directly'
);
select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['anon', 'public']::name[]
      and concat(qual, with_check) like '%roadmap-images%'
  ),
  'no anonymous storage policy targets the roadmap image bucket'
);

insert into storage.objects (bucket_id, name)
values ('roadmap-images', 'suggestions/rls-fixture/object.jpg');

set local role anon;
select is(
  (
    select count(*)
    from storage.objects
    where bucket_id = 'roadmap-images'
  ),
  0::bigint,
  'anon cannot read roadmap image objects through Storage RLS'
);
reset role;
select ok(
  has_table_privilege('authenticated', 'public.roadmap_item_images', 'select'),
  'authenticated receives metadata select for the admin RLS path'
);
select ok(
  not has_table_privilege('authenticated', 'public.roadmap_item_images', 'insert'),
  'authenticated cannot insert image metadata'
);
select ok(
  not has_table_privilege('authenticated', 'public.roadmap_item_images', 'update'),
  'authenticated cannot update image metadata'
);
select ok(
  has_table_privilege('anon', 'public.roadmap_item_images_public', 'select'),
  'anon can read the sanitized public image view'
);
select ok(
  has_table_privilege('anon', 'public.roadmap_items_public', 'select'),
  'anon retains access to the public item view'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.consume_suggestion_image_quota(text, integer)',
    'execute'
  ),
  'anon cannot consume image quota directly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.consume_suggestion_image_quota(text, integer)',
    'execute'
  ),
  'authenticated cannot consume image quota directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.consume_suggestion_image_quota(text, integer)',
    'execute'
  ),
  'service role can consume image quota'
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
  fixture.id,
  project.id,
  fixture.title,
  'Transaction-scoped image contract fixture',
  'pending',
  fixture.sort_order
from public.projects as project
cross join (
  values
    ('10000000-0000-4000-8000-000000000101'::uuid, 'Image visibility fixture', 101),
    ('10000000-0000-4000-8000-000000000102'::uuid, 'Image size boundary fixture', 102),
    ('10000000-0000-4000-8000-000000000103'::uuid, 'Image width boundary fixture', 103),
    ('10000000-0000-4000-8000-000000000104'::uuid, 'Image height boundary fixture', 104),
    ('10000000-0000-4000-8000-000000000105'::uuid, 'Image area boundary fixture', 105),
    ('10000000-0000-4000-8000-000000000106'::uuid, 'Image capacity accepted fixture', 106),
    ('10000000-0000-4000-8000-000000000107'::uuid, 'Image capacity rejected fixture', 107),
    ('10000000-0000-4000-8000-000000000108'::uuid, 'Image MIME boundary fixture', 108)
) as fixture(id, title, sort_order)
where project.slug = 'advertising-system';

create temporary table suggestion_image_usage_baseline on commit drop as
select used_bytes
from public.roadmap_image_storage_usage
where singleton;

select lives_ok(
  $$
    insert into public.roadmap_item_images (
      id,
      roadmap_item_id,
      storage_path,
      mime_type,
      size_bytes,
      width,
      height
    ) values (
      '20000000-0000-4000-8000-000000000101',
      '10000000-0000-4000-8000-000000000101',
      'suggestions/10000000-0000-4000-8000-000000000101/20000000-0000-4000-8000-000000000101.jpg',
      'image/jpeg',
      1024,
      800,
      600
    )
  $$,
  'valid image metadata reserves capacity'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000109',
      '10000000-0000-4000-8000-000000000108',
      'suggestions/10000000-0000-4000-8000-000000000108/20000000-0000-4000-8000-000000000109.webp',
      'image/webp', 1, 1, 1
    )
  $$,
  '23514',
  null,
  'unsupported image metadata MIME is rejected'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000108',
      '10000000-0000-4000-8000-000000000101',
      'suggestions/10000000-0000-4000-8000-000000000101/20000000-0000-4000-8000-000000000108.png',
      'image/png', 1, 1, 1
    )
  $$,
  '23505',
  null,
  'one roadmap item cannot have a second metadata row'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000102',
      '10000000-0000-4000-8000-000000000102',
      'suggestions/10000000-0000-4000-8000-000000000102/20000000-0000-4000-8000-000000000102.jpg',
      'image/jpeg', 5000000, 1, 1
    )
  $$,
  '23514',
  null,
  'five-million-byte metadata is rejected'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000103',
      '10000000-0000-4000-8000-000000000103',
      'suggestions/10000000-0000-4000-8000-000000000103/20000000-0000-4000-8000-000000000103.jpg',
      'image/jpeg', 1, 12001, 1
    )
  $$,
  '23514',
  null,
  'width above twelve thousand is rejected'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000104',
      '10000000-0000-4000-8000-000000000104',
      'suggestions/10000000-0000-4000-8000-000000000104/20000000-0000-4000-8000-000000000104.jpg',
      'image/jpeg', 1, 1, 12001
    )
  $$,
  '23514',
  null,
  'height above twelve thousand is rejected'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000105',
      '10000000-0000-4000-8000-000000000105',
      'suggestions/10000000-0000-4000-8000-000000000105/20000000-0000-4000-8000-000000000105.jpg',
      'image/jpeg', 1, 10000, 4001
    )
  $$,
  '23514',
  null,
  'pixel area above forty million is rejected'
);

select is(
  (
    select has_image
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  true,
  'pending item reports that metadata exists'
);
select is(
  (
    select image_id
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  null::uuid,
  'pending item does not expose its image ID'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images_public
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  0::bigint,
  'pending image has no public-view row'
);

update public.roadmap_items
set status = 'approved'
where id = '10000000-0000-4000-8000-000000000101';
select is(
  (
    select image_id
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  '20000000-0000-4000-8000-000000000101'::uuid,
  'approved item exposes its image ID'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images_public
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'approved image has one public-view row'
);

update public.roadmap_items
set status = 'in_progress'
where id = '10000000-0000-4000-8000-000000000101';
select is(
  (
    select image_id
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  '20000000-0000-4000-8000-000000000101'::uuid,
  'in-progress item exposes its image ID'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images_public
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'in-progress image has one public-view row'
);

update public.roadmap_items
set status = 'completed'
where id = '10000000-0000-4000-8000-000000000101';
select is(
  (
    select image_id
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  '20000000-0000-4000-8000-000000000101'::uuid,
  'completed item exposes its image ID'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images_public
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'completed image has one public-view row'
);

update public.roadmap_items
set status = 'rejected'
where id = '10000000-0000-4000-8000-000000000101';
select is(
  (
    select has_image
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  true,
  'rejected item still reports that image metadata exists'
);
select is(
  (
    select image_id
    from public.roadmap_items_public
    where id = '10000000-0000-4000-8000-000000000101'
  ),
  null::uuid,
  'rejected item no longer exposes its image ID'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images_public
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  0::bigint,
  'rejected image no longer has a public-view row'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'rejecting an item preserves private image metadata'
);

select set_config(
  'request.jwt.claims',
  '{"email":"viewer@internal.invalid"}',
  true
);
set local role authenticated;
select is(
  (
    select count(*)
    from public.roadmap_item_images
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  0::bigint,
  'non-admin authenticated user cannot read image metadata'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"email":"roadmap-admin@internal.invalid"}',
  true
);
set local role authenticated;
select is(
  (
    select count(*)
    from public.roadmap_item_images
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'authenticated administrator can read image metadata'
);
reset role;
select set_config('request.jwt.claims', '{}', true);

select lives_ok(
  $$
    delete from public.roadmap_items
    where id = '10000000-0000-4000-8000-000000000101'
  $$,
  'deleting an item cascades its image metadata'
);
select is(
  (
    select count(*)
    from public.roadmap_item_images
    where id = '20000000-0000-4000-8000-000000000101'
  ),
  0::bigint,
  'cascaded image metadata is deleted'
);
select is(
  (select used_bytes from public.roadmap_image_storage_usage where singleton),
  (select used_bytes from suggestion_image_usage_baseline),
  'cascade deletion returns reserved bytes to the starting value'
);

update public.roadmap_image_storage_usage
set used_bytes = 899999999
where singleton;
select lives_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000106',
      '10000000-0000-4000-8000-000000000106',
      'suggestions/10000000-0000-4000-8000-000000000106/20000000-0000-4000-8000-000000000106.png',
      'image/png', 1, 1, 1
    )
  $$,
  'one byte can fill the remaining logical capacity'
);
select is(
  (select used_bytes from public.roadmap_image_storage_usage where singleton),
  900000000::bigint,
  'one-byte reservation reaches the logical cap exactly'
);
select throws_ok(
  $$
    insert into public.roadmap_item_images (
      id, roadmap_item_id, storage_path, mime_type, size_bytes, width, height
    ) values (
      '20000000-0000-4000-8000-000000000107',
      '10000000-0000-4000-8000-000000000107',
      'suggestions/10000000-0000-4000-8000-000000000107/20000000-0000-4000-8000-000000000107.png',
      'image/png', 1, 1, 1
    )
  $$,
  'P0001',
  'roadmap_image_storage_full',
  'another one-byte reservation above the cap is rejected'
);
select lives_ok(
  $$
    delete from public.roadmap_item_images
    where id = '20000000-0000-4000-8000-000000000106'
  $$,
  'deleting the accepted capacity fixture releases one byte'
);
select is(
  (select used_bytes from public.roadmap_image_storage_usage where singleton),
  899999999::bigint,
  'capacity deletion returns usage to the seeded value'
);
update public.roadmap_image_storage_usage
set used_bytes = 0
where singleton;
select is(
  (select used_bytes from public.roadmap_image_storage_usage where singleton),
  0::bigint,
  'capacity fixture resets usage to zero before rollback'
);

insert into public.suggestion_image_rate_limits (ip_hash, created_at)
values (repeat('e', 64), now() - interval '49 hours');
select is(
  public.consume_suggestion_image_quota(repeat('f', 64), 3),
  true,
  'first image quota event is allowed'
);
select is(
  (
    select count(*)
    from public.suggestion_image_rate_limits
    where ip_hash = repeat('e', 64)
  ),
  0::bigint,
  'quota consumption deletes events older than forty-eight hours'
);
select is(
  public.consume_suggestion_image_quota(repeat('f', 64), 3),
  true,
  'second image quota event is allowed'
);
select is(
  public.consume_suggestion_image_quota(repeat('f', 64), 3),
  true,
  'third image quota event is allowed'
);
select is(
  public.consume_suggestion_image_quota(repeat('f', 64), 3),
  false,
  'fourth image quota event is rejected'
);

update public.suggestion_image_rate_limits
set created_at = now() - interval '25 hours'
where id = (
  select id
  from public.suggestion_image_rate_limits
  where ip_hash = repeat('f', 64)
  order by created_at, id
  limit 1
);
select is(
  public.consume_suggestion_image_quota(repeat('f', 64), 3),
  true,
  'an event older than twenty-four hours restores one quota slot'
);

select * from finish();
rollback;
