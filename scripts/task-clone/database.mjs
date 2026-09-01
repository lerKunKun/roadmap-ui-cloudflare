import { parseCloneManifest } from "./model.mjs"

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/

export function buildSnapshotSql(sourceRef) {
  if (!PROJECT_REF_PATTERN.test(sourceRef)) {
    throw new Error("源 Supabase Project Ref 无效")
  }

  return `begin transaction isolation level repeatable read read only;
with captured as (
  select clock_timestamp() as captured_at
)
select jsonb_build_object(
  'version', 1,
  'capturedAt', to_char(captured.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'sourceProjectRef', '${sourceRef}',
  'projects', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', project.id,
      'name', project.name,
      'slug', project.slug,
      'projectUrl', project.project_url,
      'sortOrder', project.sort_order,
      'createdAt', project.created_at,
      'updatedAt', project.updated_at
    ) order by project.sort_order, project.created_at, project.id)
    from public.projects as project
  ), '[]'::jsonb),
  'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', item.id,
      'projectId', item.project_id,
      'title', item.title,
      'description', item.description,
      'status', item.status,
      'sortOrder', item.sort_order,
      'createdAt', item.created_at,
      'updatedAt', item.updated_at,
      'voteBaseline', public.roadmap_vote_count(item.id)::text
    ) order by item.project_id, item.status, item.sort_order, item.created_at, item.id)
    from public.roadmap_items as item
  ), '[]'::jsonb),
  'histories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'sourceOrder', history.id::text,
      'roadmapItemId', history.roadmap_item_id,
      'fromStatus', history.from_status,
      'toStatus', history.to_status,
      'changedAt', history.changed_at
    ) order by history.roadmap_item_id, history.changed_at, history.id)
    from public.roadmap_status_history as history
  ), '[]'::jsonb),
  'images', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', image.id,
      'roadmapItemId', image.roadmap_item_id,
      'storagePath', image.storage_path,
      'mimeType', image.mime_type,
      'sizeBytes', image.size_bytes,
      'width', image.width,
      'height', image.height,
      'createdAt', image.created_at,
      'sha256', null
    ) order by image.storage_path, image.id)
    from public.roadmap_item_images as image
  ), '[]'::jsonb)
) as snapshot
from captured;
commit;`
}

export function parseDbQueryJson(stdout) {
  return parseDbQueryColumn(stdout, "snapshot", "数据库快照结果无效")
}

export function parseDbQueryColumn(stdout, column, errorMessage = "数据库查询结果无效") {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw new Error(errorMessage)
  }
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(errorMessage)

  try {
    const result = JSON.parse(stdout.slice(start, end + 1))
    if (!Array.isArray(result.rows) || result.rows.length !== 1) {
      throw new Error("invalid rows")
    }
    const value = result.rows[0]?.[column]
    if (!value || typeof value !== "object") throw new Error("missing column")
    return value
  } catch {
    throw new Error(errorMessage)
  }
}

export async function captureSourceSnapshot({ query, sourceRef }) {
  const result = await query({
    projectRef: sourceRef,
    sql: buildSnapshotSql(sourceRef),
    operation: "读取源 Roadmap 快照",
  })
  const manifest = parseCloneManifest(
    parseDbQueryJson(typeof result === "string" ? result : result.stdout),
  )
  if (manifest.sourceProjectRef !== sourceRef) {
    throw new Error("数据库快照来源不匹配")
  }
  return manifest
}

export function buildImportSql(inputManifest) {
  const manifest = parseCloneManifest(inputManifest)
  const payload = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64")

  return `begin;
select pg_advisory_xact_lock(hashtextextended('task-roadmap-clone-v1', 0));

do $$
begin
  if exists (select 1 from public.roadmap_items)
    or exists (select 1 from public.votes)
    or exists (select 1 from public.suggestion_rate_limits)
    or exists (select 1 from public.suggestion_image_rate_limits)
    or exists (select 1 from public.roadmap_item_images)
    or (select used_bytes from public.roadmap_image_storage_usage where singleton) <> 0
  then
    raise exception 'task_clone_target_not_fresh';
  end if;

  if (
    select coalesce(array_agg(slug order by sort_order, created_at, id), array[]::text[])
    from public.projects
  ) <> array['advertising-system', 'ks-alert', 'template-tools', 'other']::text[]
  then
    raise exception 'task_clone_target_projects_not_seeded';
  end if;
end;
$$;

create temporary table task_clone_payload (document jsonb not null) on commit drop;
insert into task_clone_payload (document)
values (
  convert_from(decode($snapshot$${payload}$snapshot$, 'base64'), 'UTF8')::jsonb
);

delete from public.projects;

insert into public.projects (
  id,
  name,
  slug,
  project_url,
  sort_order,
  created_at,
  updated_at
)
select
  source."id",
  source."name",
  source."slug",
  source."projectUrl",
  source."sortOrder",
  source."createdAt",
  source."updatedAt"
from task_clone_payload as payload
cross join lateral jsonb_to_recordset(payload.document -> 'projects') as source(
  "id" uuid,
  "name" text,
  "slug" text,
  "projectUrl" text,
  "sortOrder" integer,
  "createdAt" timestamptz,
  "updatedAt" timestamptz
);

insert into public.roadmap_items (
  id,
  project_id,
  title,
  description,
  status,
  sort_order,
  created_at,
  updated_at,
  vote_baseline
)
select
  source."id",
  source."projectId",
  source."title",
  source."description",
  source."status",
  source."sortOrder",
  source."createdAt",
  source."updatedAt",
  source."voteBaseline"::bigint
from task_clone_payload as payload
cross join lateral jsonb_to_recordset(payload.document -> 'items') as source(
  "id" uuid,
  "projectId" uuid,
  "title" text,
  "description" text,
  "status" text,
  "sortOrder" integer,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "voteBaseline" text
);

delete from public.roadmap_status_history;

insert into public.roadmap_status_history (
  roadmap_item_id,
  from_status,
  to_status,
  changed_at
)
select
  source."roadmapItemId",
  source."fromStatus",
  source."toStatus",
  source."changedAt"
from task_clone_payload as payload
cross join lateral jsonb_to_recordset(payload.document -> 'histories') as source(
  "sourceOrder" bigint,
  "roadmapItemId" uuid,
  "fromStatus" text,
  "toStatus" text,
  "changedAt" timestamptz
)
order by source."sourceOrder";

insert into public.roadmap_item_images (
  id,
  roadmap_item_id,
  storage_path,
  mime_type,
  size_bytes,
  width,
  height,
  created_at
)
select
  source."id",
  source."roadmapItemId",
  source."storagePath",
  source."mimeType",
  source."sizeBytes",
  source."width",
  source."height",
  source."createdAt"
from task_clone_payload as payload
cross join lateral jsonb_to_recordset(payload.document -> 'images') as source(
  "id" uuid,
  "roadmapItemId" uuid,
  "storagePath" text,
  "mimeType" text,
  "sizeBytes" integer,
  "width" integer,
  "height" integer,
  "createdAt" timestamptz,
  "sha256" text
);

do $$
begin
  if exists (select 1 from public.votes)
    or exists (select 1 from public.suggestion_rate_limits)
    or exists (select 1 from public.suggestion_image_rate_limits)
  then
    raise exception 'task_clone_operational_state_not_empty';
  end if;

  if (select count(*) from public.projects)
      <> (select jsonb_array_length(document -> 'projects') from task_clone_payload)
    or (select count(*) from public.roadmap_items)
      <> (select jsonb_array_length(document -> 'items') from task_clone_payload)
    or (select count(*) from public.roadmap_status_history)
      <> (select jsonb_array_length(document -> 'histories') from task_clone_payload)
    or (select count(*) from public.roadmap_item_images)
      <> (select jsonb_array_length(document -> 'images') from task_clone_payload)
  then
    raise exception 'task_clone_import_count_mismatch';
  end if;
end;
$$;

select jsonb_build_object('imported', true) as result;
commit;`
}

export function buildTargetAuditSql() {
  return `begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'projects', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', project.id,
      'name', project.name,
      'slug', project.slug,
      'projectUrl', project.project_url,
      'sortOrder', project.sort_order,
      'createdAt', project.created_at,
      'updatedAt', project.updated_at
    ) order by project.sort_order, project.created_at, project.id)
    from public.projects as project
  ), '[]'::jsonb),
  'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', item.id,
      'projectId', item.project_id,
      'title', item.title,
      'description', item.description,
      'status', item.status,
      'sortOrder', item.sort_order,
      'createdAt', item.created_at,
      'updatedAt', item.updated_at,
      'voteBaseline', item.vote_baseline::text,
      'voteCount', public.roadmap_vote_count(item.id)::text
    ) order by item.project_id, item.status, item.sort_order, item.created_at, item.id)
    from public.roadmap_items as item
  ), '[]'::jsonb),
  'histories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'roadmapItemId', history.roadmap_item_id,
      'fromStatus', history.from_status,
      'toStatus', history.to_status,
      'changedAt', history.changed_at
    ) order by history.roadmap_item_id, history.changed_at, history.id)
    from public.roadmap_status_history as history
  ), '[]'::jsonb),
  'images', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', image.id,
      'roadmapItemId', image.roadmap_item_id,
      'storagePath', image.storage_path,
      'mimeType', image.mime_type,
      'sizeBytes', image.size_bytes,
      'width', image.width,
      'height', image.height,
      'createdAt', image.created_at
    ) order by image.storage_path, image.id)
    from public.roadmap_item_images as image
  ), '[]'::jsonb),
  'operationalCounts', jsonb_build_object(
    'votes', (select count(*) from public.votes),
    'suggestionRateLimits', (select count(*) from public.suggestion_rate_limits),
    'suggestionImageRateLimits', (select count(*) from public.suggestion_image_rate_limits)
  ),
  'usedBytes', (select used_bytes from public.roadmap_image_storage_usage where singleton),
  'bucket', (
    select jsonb_build_object(
      'public', bucket.public,
      'fileSizeLimit', bucket.file_size_limit,
      'allowedMimeTypes', (
        select jsonb_agg(mime order by mime)
        from unnest(bucket.allowed_mime_types) as mime
      )
    )
    from storage.buckets as bucket
    where bucket.id = 'roadmap-images'
  ),
  'authUsers', coalesce((
    select jsonb_agg(jsonb_build_object('email', user_row.email) order by user_row.email)
    from auth.users as user_row
  ), '[]'::jsonb)
) as audit;
commit;`
}

export async function importSnapshot({ query, targetRef, manifest }) {
  if (!PROJECT_REF_PATTERN.test(targetRef)) {
    throw new Error("目标 Supabase Project Ref 无效")
  }
  const result = await query({
    projectRef: targetRef,
    sql: buildImportSql(manifest),
    operation: "导入目标 Roadmap 快照",
  })
  const imported = parseDbQueryColumn(
    typeof result === "string" ? result : result.stdout,
    "result",
    "数据库导入结果无效",
  )
  if (imported.imported !== true) throw new Error("数据库导入未确认完成")
  return imported
}

export async function auditTarget({ query, targetRef }) {
  if (!PROJECT_REF_PATTERN.test(targetRef)) {
    throw new Error("目标 Supabase Project Ref 无效")
  }
  const result = await query({
    projectRef: targetRef,
    sql: buildTargetAuditSql(),
    operation: "核对目标 Roadmap 数据",
  })
  return parseDbQueryColumn(
    typeof result === "string" ? result : result.stdout,
    "audit",
    "目标数据库核对结果无效",
  )
}
