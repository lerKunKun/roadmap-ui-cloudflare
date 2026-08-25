begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select has_table('public', 'projects', 'projects table exists');
select has_table('public', 'roadmap_items', 'roadmap_items table exists');
select has_table('public', 'votes', 'votes table exists');
select has_view('public', 'roadmap_items_public', 'public item view exists');

select results_eq(
  $$select name from public.projects order by sort_order$$,
  $$values ('广告系统'::text), ('ks-alert'::text), ('模板工具'::text), ('其他'::text)$$,
  'four initial projects are ordered'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.projects'::regclass),
  'projects enables RLS'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.roadmap_items'::regclass),
  'roadmap_items enables RLS'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.votes'::regclass),
  'votes enables RLS'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.votes'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (roadmap_item_id, ip_hash)'
  ),
  'one IP hash can vote once per item'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.roadmap_items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%pending%approved%in_progress%completed%rejected%'
  ),
  'status is restricted to the five roadmap stages'
);

select ok(has_table_privilege('anon', 'public.projects', 'select'), 'anon reads projects');
select ok(has_table_privilege('anon', 'public.roadmap_items_public', 'select'), 'anon reads safe item view');
select ok(not has_table_privilege('anon', 'public.projects', 'insert'), 'anon cannot insert projects');
select ok(not has_table_privilege('anon', 'public.roadmap_items', 'insert'), 'anon cannot insert items');
select ok(not has_table_privilege('anon', 'public.votes', 'select'), 'anon cannot read vote hashes');
select ok(has_table_privilege('service_role', 'public.projects', 'select'), 'Edge Functions can read projects');
select ok(has_table_privilege('service_role', 'public.roadmap_items', 'insert'), 'Edge Functions can insert suggestions');
select ok(has_table_privilege('service_role', 'public.votes', 'insert'), 'Edge Functions can insert votes');

select is(
  (select set_config('request.jwt.claims', '{"email":"viewer@internal.invalid"}', true)),
  '{"email":"viewer@internal.invalid"}',
  'non-admin JWT fixture is active'
);
select is(public.is_roadmap_admin(), false, 'non-admin JWT is rejected');

select set_config('request.jwt.claims', '{"email":"roadmap-admin@internal.invalid"}', true);
select is(public.is_roadmap_admin(), true, 'fixed admin JWT is accepted');

select has_table('public', 'suggestion_rate_limits', 'suggestion rate limit table exists');
select has_function('public', 'consume_suggestion_quota', array['text', 'integer'], 'suggestion quota function exists');
select has_function('public', 'move_roadmap_item', array['uuid', 'text', 'integer'], 'atomic item move function exists');
select has_function('public', 'move_project', array['uuid', 'integer'], 'atomic project move function exists');
select ok(
  not has_function_privilege('anon', 'public.consume_suggestion_quota(text, integer)', 'execute'),
  'anon cannot consume suggestion quota directly'
);

select is(public.consume_suggestion_quota(repeat('a', 64), 2), true, 'first suggestion is allowed');
select is(public.consume_suggestion_quota(repeat('a', 64), 2), true, 'second suggestion is allowed');
select is(public.consume_suggestion_quota(repeat('a', 64), 2), false, 'hourly suggestion quota is enforced');

insert into public.roadmap_items (id, project_id, title, description, status, sort_order)
select
  '10000000-0000-4000-8000-000000000001'::uuid,
  id,
  '数据库权限验收',
  '用于 pgTAP 角色和排序测试',
  'pending',
  0
from public.projects
where slug = 'advertising-system';

select lives_ok(
  $$insert into public.votes (roadmap_item_id, ip_hash) values ('10000000-0000-4000-8000-000000000001', repeat('b', 64))$$,
  'first database vote succeeds'
);
select throws_ok(
  $$insert into public.votes (roadmap_item_id, ip_hash) values ('10000000-0000-4000-8000-000000000001', repeat('b', 64))$$,
  '23505',
  null,
  'duplicate database vote is rejected'
);

set local role anon;
select throws_ok(
  $$insert into public.projects (name, slug) values ('匿名越权', 'anon-denied')$$,
  '42501',
  null,
  'anon project insert is rejected at execution time'
);
reset role;

select set_config('request.jwt.claims', '{"email":"viewer@internal.invalid"}', true);
set local role authenticated;
select throws_ok(
  $$insert into public.projects (name, slug) values ('普通用户越权', 'viewer-denied')$$,
  '42501',
  null,
  'non-admin authenticated project insert is rejected by RLS'
);
reset role;

select set_config('request.jwt.claims', '{"email":"roadmap-admin@internal.invalid"}', true);
set local role authenticated;
select lives_ok(
  $$insert into public.projects (id, name, slug, sort_order) values ('20000000-0000-4000-8000-000000000001', '管理员验收项目', 'admin-allowed', 10)$$,
  'fixed admin can insert a project'
);
select is(
  public.move_project('20000000-0000-4000-8000-000000000001', 0),
  0,
  'fixed admin can atomically move a project'
);
select is(
  (select sort_order from public.projects where id = '20000000-0000-4000-8000-000000000001'),
  0,
  'atomic project move updates its sort order'
);
select lives_ok(
  $$select public.move_roadmap_item('10000000-0000-4000-8000-000000000001', 'in_progress', 0)$$,
  'fixed admin can atomically move an item'
);
select is(
  (select status from public.roadmap_items where id = '10000000-0000-4000-8000-000000000001'),
  'in_progress',
  'atomic move updates the item status'
);
select throws_ok(
  $$delete from public.projects where slug = 'advertising-system'$$,
  '23503',
  null,
  'project deletion remains restricted while it has items'
);
reset role;

select * from finish();
rollback;
