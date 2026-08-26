begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

select has_table('public', 'roadmap_status_history', 'status history table exists');
select has_view('public', 'roadmap_status_history_public', 'public status history view exists');
select ok(
  coalesce(
    (
      select relrowsecurity
      from pg_class
      where oid = to_regclass('public.roadmap_status_history')
    ),
    false
  ),
  'status history enables RLS'
);
select has_index(
  'public',
  'roadmap_status_history',
  'roadmap_status_history_item_time_idx',
  'status history has stable item timeline index'
);
select has_function(
  'public',
  'record_roadmap_status_history',
  array[]::text[],
  'status history trigger function exists'
);
select has_trigger(
  'public',
  'roadmap_items',
  'roadmap_items_record_status_history',
  'roadmap item history trigger exists'
);
select ok(
  has_table_privilege('anon', 'public.roadmap_status_history_public', 'select'),
  'anon reads public status history'
);
select ok(
  not has_table_privilege('anon', 'public.roadmap_status_history', 'insert'),
  'anon cannot insert status history'
);
select is(
  (
    select count(*)::integer
    from public.roadmap_items as item
    where not exists (
      select 1
      from public.roadmap_status_history as history
      where history.roadmap_item_id = item.id
    )
  ),
  0,
  'migration backfills every existing item'
);

insert into public.projects (id, name, slug, sort_order)
values (
  '30000000-0000-4000-8000-000000000001',
  '状态时间轴验收项目',
  'status-history-test',
  1000000
);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order
)
values (
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001',
  '状态时间轴验收条目',
  '事务结束后自动回滚',
  'pending',
  0
);

select results_eq(
  $$
    select from_status, to_status
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
    order by changed_at, id
  $$,
  $$values (null::text, 'pending'::text)$$,
  'item creation records its initial status'
);

update public.roadmap_items
set description = '只修改说明'
where id = '30000000-0000-4000-8000-000000000002';

select is(
  (
    select count(*)::integer
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
  ),
  1,
  'non-status update does not append history'
);

set local role anon;
select throws_ok(
  $$
    insert into public.roadmap_status_history (
      roadmap_item_id,
      from_status,
      to_status
    ) values (
      '30000000-0000-4000-8000-000000000002',
      'pending',
      'approved'
    )
  $$,
  '42501',
  null,
  'anon cannot write status history'
);
reset role;

select set_config('request.jwt.claims', '{"email":"roadmap-admin@internal.invalid"}', true);
set local role authenticated;

select lives_ok(
  $$
    select public.move_roadmap_item(
      '30000000-0000-4000-8000-000000000002',
      'in_progress',
      0
    )
  $$,
  'admin status transition succeeds'
);
select results_eq(
  $$
    select from_status, to_status
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
    order by changed_at, id
  $$,
  $$values (null::text, 'pending'::text), ('pending'::text, 'in_progress'::text)$$,
  'status transition appends ordered history'
);

select public.move_roadmap_item(
  '30000000-0000-4000-8000-000000000002',
  'in_progress',
  0
);
select is(
  (
    select count(*)::integer
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
  ),
  2,
  'same-status reorder does not append history'
);

select public.move_roadmap_item(
  '30000000-0000-4000-8000-000000000002',
  'approved',
  0
);
select is(
  (
    select count(*)::integer
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
  ),
  3,
  'reverse transition preserves earlier history'
);

delete from public.roadmap_items
where id = '30000000-0000-4000-8000-000000000002';
select is(
  (
    select count(*)::integer
    from public.roadmap_status_history
    where roadmap_item_id = '30000000-0000-4000-8000-000000000002'
  ),
  0,
  'item deletion cascades to status history'
);

reset role;
select * from finish();
rollback;
