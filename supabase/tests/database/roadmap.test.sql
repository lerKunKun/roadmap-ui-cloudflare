begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

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

select * from finish();
rollback;
