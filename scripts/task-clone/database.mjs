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
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw new Error("数据库快照结果无效")
  }
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("数据库快照结果无效")

  try {
    const result = JSON.parse(stdout.slice(start, end + 1))
    if (!Array.isArray(result.rows) || result.rows.length !== 1) {
      throw new Error("invalid rows")
    }
    const snapshot = result.rows[0]?.snapshot
    if (!snapshot || typeof snapshot !== "object") throw new Error("missing snapshot")
    return snapshot
  } catch {
    throw new Error("数据库快照结果无效")
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
