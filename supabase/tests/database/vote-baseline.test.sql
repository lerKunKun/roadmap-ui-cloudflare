begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

select has_column(
  'public',
  'roadmap_items',
  'vote_baseline',
  'roadmap items expose an internal vote baseline'
);
select col_type_is(
  'public',
  'roadmap_items',
  'vote_baseline',
  'bigint',
  'vote baseline uses bigint'
);
select col_not_null(
  'public',
  'roadmap_items',
  'vote_baseline',
  'vote baseline cannot be null'
);
select col_default_is(
  'public',
  'roadmap_items',
  'vote_baseline',
  '0',
  'vote baseline defaults to zero'
);
select hasnt_column(
  'public',
  'roadmap_items_public',
  'vote_baseline',
  'public item view does not expose the internal baseline'
);

insert into public.projects (
  id,
  name,
  slug,
  sort_order
) values (
  '90000000-0000-4000-8000-000000000001',
  '票数基线测试',
  'vote-baseline-test',
  999
);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order
) values (
  '90000000-0000-4000-8000-000000000002',
  '90000000-0000-4000-8000-000000000001',
  '默认基线条目',
  '',
  'approved',
  0
);

select is(
  (
    select vote_baseline
    from public.roadmap_items
    where id = '90000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'new items start with a zero baseline'
);

select throws_ok(
  $$
    insert into public.roadmap_items (
      id,
      project_id,
      title,
      status,
      vote_baseline
    ) values (
      '90000000-0000-4000-8000-000000000003',
      '90000000-0000-4000-8000-000000000001',
      '非法负票数',
      'approved',
      -1
    )
  $$,
  '23514',
  null,
  'negative vote baselines are rejected'
);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order,
  vote_baseline
) values (
  '90000000-0000-4000-8000-000000000009',
  '90000000-0000-4000-8000-000000000001',
  '历史票数条目',
  '',
  'approved',
  1,
  7
);

insert into public.votes (roadmap_item_id, ip_hash)
values
  ('90000000-0000-4000-8000-000000000009', repeat('a', 64)),
  ('90000000-0000-4000-8000-000000000009', repeat('b', 64));

select is(
  public.roadmap_vote_count('90000000-0000-4000-8000-000000000009'),
  9::bigint,
  'public total is baseline plus new votes'
);
select is(
  (
    select vote_count
    from public.roadmap_items_public
    where id = '90000000-0000-4000-8000-000000000009'
  ),
  9::bigint,
  'public view returns the combined total'
);

delete from public.roadmap_items
where id = '90000000-0000-4000-8000-000000000009';

select is(
  (
    select count(*)::bigint
    from public.votes
    where roadmap_item_id = '90000000-0000-4000-8000-000000000009'
  ),
  0::bigint,
  'deleting an item still cascades its new votes'
);

select * from finish();
rollback;
