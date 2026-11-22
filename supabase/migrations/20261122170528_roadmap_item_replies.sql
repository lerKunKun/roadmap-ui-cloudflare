create table public.roadmap_item_replies (
  id uuid primary key default gen_random_uuid(),
  roadmap_item_id uuid not null references public.roadmap_items(id) on delete cascade,
  body text not null check (body ~ '[^[:space:]]' and char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

create index roadmap_item_replies_timeline_idx
  on public.roadmap_item_replies (roadmap_item_id, created_at, id);

alter table public.roadmap_item_replies enable row level security;

revoke all on table public.roadmap_item_replies from public, anon, authenticated;
grant select on table public.roadmap_item_replies to anon, authenticated;
grant insert (roadmap_item_id, body) on public.roadmap_item_replies to authenticated;

create policy "public reads replies" on public.roadmap_item_replies
for select to anon, authenticated using (true);

create policy "admin publishes replies" on public.roadmap_item_replies
for insert to authenticated with check ((select public.is_roadmap_admin()));

-- On the mirrored instance the source is the sole writer for advertising.
do $$
begin
  if to_regclass('public.roadmap_advertising_sync_state') is not null then
    create policy "mirrored advertising replies are published on the source"
    on public.roadmap_item_replies as restrictive
    for insert to authenticated
    with check (not exists (
      select 1 from public.roadmap_items as item
      join public.projects as project on project.id = item.project_id
      where item.id = roadmap_item_id and project.slug = 'advertising-system'
    ));
  end if;
end
$$;
