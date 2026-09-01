alter table public.roadmap_items
  add column vote_baseline bigint not null default 0
  check (vote_baseline >= 0);

create or replace function public.roadmap_vote_count(target_item_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select item.vote_baseline
      from public.roadmap_items as item
      where item.id = target_item_id
    ), 0::bigint)
    + (
      select count(*)::bigint
      from public.votes
      where roadmap_item_id = target_item_id
    )
$$;

revoke all on function public.roadmap_vote_count(uuid) from public;
grant execute on function public.roadmap_vote_count(uuid)
  to anon, authenticated, service_role;

comment on column public.roadmap_items.vote_baseline is
  'Aggregate votes imported without retaining historical voter identifiers.';
