create or replace function public.export_advertising_roadmap_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  advertising_project public.projects%rowtype;
  matching_project_count integer;
  captured_at timestamptz := clock_timestamp();
  snapshot jsonb;
begin
  select count(*)::integer
  into matching_project_count
  from public.projects
  where slug = 'advertising-system';

  if matching_project_count <> 1 then
    raise exception 'advertising_sync_source_project_invalid'
      using errcode = 'P0002';
  end if;

  select *
  into strict advertising_project
  from public.projects
  where slug = 'advertising-system';

  select jsonb_build_object(
    'version', 1,
    'capturedAt', captured_at,
    'project', jsonb_build_object(
      'id', advertising_project.id,
      'name', advertising_project.name,
      'slug', advertising_project.slug,
      'projectUrl', advertising_project.project_url,
      'sortOrder', advertising_project.sort_order,
      'createdAt', advertising_project.created_at,
      'updatedAt', advertising_project.updated_at
    ),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', item.id,
          'projectId', item.project_id,
          'title', item.title,
          'description', item.description,
          'status', item.status,
          'sortOrder', item.sort_order,
          'createdAt', item.created_at,
          'updatedAt', item.updated_at,
          'voteBaseline', public.roadmap_vote_count(item.id)::text
        )
        order by item.status, item.sort_order, item.created_at, item.id
      )
      from public.roadmap_items as item
      where item.project_id = advertising_project.id
    ), '[]'::jsonb),
    'histories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceOrder', history.id::text,
          'roadmapItemId', history.roadmap_item_id,
          'fromStatus', history.from_status,
          'toStatus', history.to_status,
          'changedAt', history.changed_at
        )
        order by history.roadmap_item_id, history.changed_at, history.id
      )
      from public.roadmap_status_history as history
      join public.roadmap_items as item
        on item.id = history.roadmap_item_id
      where item.project_id = advertising_project.id
    ), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', image.id,
          'roadmapItemId', image.roadmap_item_id,
          'storagePath', image.storage_path,
          'mimeType', image.mime_type,
          'sizeBytes', image.size_bytes,
          'width', image.width,
          'height', image.height,
          'createdAt', image.created_at
        )
        order by image.storage_path, image.id
      )
      from public.roadmap_item_images as image
      join public.roadmap_items as item
        on item.id = image.roadmap_item_id
      where item.project_id = advertising_project.id
    ), '[]'::jsonb)
  )
  into snapshot;

  return snapshot;
end;
$$;

revoke all on function public.export_advertising_roadmap_snapshot() from public;
grant execute on function public.export_advertising_roadmap_snapshot()
  to service_role;

comment on function public.export_advertising_roadmap_snapshot() is
  'Exports the fixed advertising-system Roadmap without voter identifiers or runtime secrets.';
