create table public.roadmap_status_history (
  id bigint generated always as identity primary key,
  roadmap_item_id uuid not null
    references public.roadmap_items(id) on delete cascade,
  from_status text
    check (
      from_status is null
      or from_status in ('pending', 'approved', 'in_progress', 'completed', 'rejected')
    ),
  to_status text not null
    check (to_status in ('pending', 'approved', 'in_progress', 'completed', 'rejected')),
  changed_at timestamptz not null default now(),
  check (from_status is null or from_status <> to_status)
);

create index roadmap_status_history_item_time_idx
  on public.roadmap_status_history (roadmap_item_id, changed_at, id);

create or replace function public.record_roadmap_status_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.roadmap_status_history (
      roadmap_item_id,
      from_status,
      to_status,
      changed_at
    )
    values (new.id, null, new.status, new.created_at);
  elsif old.status is distinct from new.status then
    insert into public.roadmap_status_history (
      roadmap_item_id,
      from_status,
      to_status,
      changed_at
    )
    values (new.id, old.status, new.status, new.updated_at);
  end if;

  return new;
end;
$$;

insert into public.roadmap_status_history (
  roadmap_item_id,
  from_status,
  to_status,
  changed_at
)
select id, null, status, updated_at
from public.roadmap_items;

create trigger roadmap_items_record_status_history
after insert or update of status on public.roadmap_items
for each row execute function public.record_roadmap_status_history();

create view public.roadmap_status_history_public
with (security_invoker = true, security_barrier = true)
as
select id, roadmap_item_id, from_status, to_status, changed_at
from public.roadmap_status_history;

alter table public.roadmap_status_history enable row level security;

create policy "public reads status history"
on public.roadmap_status_history
for select
to anon, authenticated
using (true);

revoke all on function public.record_roadmap_status_history() from public;
revoke all on table public.roadmap_status_history from anon, authenticated, service_role;
revoke all on table public.roadmap_status_history_public from anon, authenticated, service_role;
grant select on table public.roadmap_status_history to anon, authenticated, service_role;
grant select on table public.roadmap_status_history_public to anon, authenticated, service_role;

comment on table public.roadmap_status_history is
  'Append-only roadmap status history written by a database trigger.';
comment on function public.record_roadmap_status_history() is
  'Records initial and changed Roadmap statuses in the same transaction as the item write.';
comment on view public.roadmap_status_history_public is
  'Public-safe Roadmap status transitions with no actor or sensitive identifiers.';
