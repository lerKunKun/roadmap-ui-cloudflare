import {
  isRoadmapStatus,
  type Project,
  type RoadmapItem,
  type RoadmapStatusHistoryEntry,
  type SuggestionInput,
  type VoteResult,
} from "@/features/roadmap/types"
import {
  getSupabaseBrowserClient,
  getSupabasePublicConfig,
} from "@/lib/supabase/browser"

interface ProjectRow {
  id: string
  name: string
  slug: string
  project_url: string | null
  sort_order: number
}

interface RoadmapItemRow {
  id: string
  project_id: string
  title: string
  description: string
  status: string
  sort_order: number
  vote_count: string | number | null
  created_at: string
  updated_at: string
}

interface RoadmapStatusHistoryRow {
  id: number
  roadmap_item_id: string
  from_status: string | null
  to_status: string
  changed_at: string
}

export function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    projectUrl: row.project_url,
    sortOrder: row.sort_order,
  }
}

export function mapRoadmapItemRow(row: RoadmapItemRow): RoadmapItem {
  if (!isRoadmapStatus(row.status)) {
    throw new Error("Roadmap 状态无效")
  }

  const voteCount = Number(row.vote_count ?? 0)

  if (!Number.isSafeInteger(voteCount) || voteCount < 0) {
    throw new Error("Roadmap 票数无效")
  }

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order,
    voteCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapRoadmapStatusHistoryRow(
  row: RoadmapStatusHistoryRow
): RoadmapStatusHistoryEntry {
  if (
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    (row.from_status !== null && !isRoadmapStatus(row.from_status)) ||
    !isRoadmapStatus(row.to_status)
  ) {
    throw new Error("Roadmap 状态历史无效")
  }

  return {
    id: row.id,
    roadmapItemId: row.roadmap_item_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedAt: row.changed_at,
  }
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("projects")
    .select("id,name,slug,project_url,sort_order")
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error("项目列表加载失败，请稍后重试")
  }

  return ((data ?? []) as ProjectRow[]).map(mapProjectRow)
}

export async function listRoadmapItems(
  projectId: string
): Promise<RoadmapItem[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_items_public")
    .select(
      "id,project_id,title,description,status,sort_order,vote_count,created_at,updated_at"
    )
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error("Roadmap 加载失败，请稍后重试")
  }

  return ((data ?? []) as RoadmapItemRow[]).map(mapRoadmapItemRow)
}

export async function listRoadmapStatusHistory(
  itemId: string
): Promise<RoadmapStatusHistoryEntry[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_status_history_public")
    .select("id,roadmap_item_id,from_status,to_status,changed_at")
    .eq("roadmap_item_id", itemId)
    .order("changed_at", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    throw new Error("状态时间轴加载失败，请稍后重试")
  }

  return ((data ?? []) as RoadmapStatusHistoryRow[]).map(
    mapRoadmapStatusHistoryRow
  )
}

async function invokeJsonPublicFunction<T>(
  functionName: "vote",
  body: unknown
): Promise<T> {
  const { url, publishableKey } = getSupabasePublicConfig()
  const response = await fetch(`${url}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as {
    message?: string
  } | null

  if (!response.ok) {
    throw new Error(payload?.message ?? "请求失败，请稍后重试")
  }

  return payload as T
}

export async function submitSuggestion(
  input: SuggestionInput
): Promise<{ itemId: string }> {
  const { url, publishableKey } = getSupabasePublicConfig()
  const formData = new FormData()
  formData.set("projectId", input.projectId)
  formData.set("title", input.title)
  formData.set("description", input.description)
  if (input.image) {
    formData.set("image", input.image, input.image.name)
  }

  const response = await fetch(`${url}/functions/v1/submit-suggestion`, {
    method: "POST",
    headers: { apikey: publishableKey },
    body: formData,
  })
  const payload = (await response.json().catch(() => null)) as {
    itemId?: string
    message?: string
  } | null

  if (!response.ok) {
    throw new Error(payload?.message ?? "请求失败，请稍后重试")
  }

  return payload as { itemId: string }
}

export async function voteForItem(roadmapItemId: string): Promise<VoteResult> {
  return invokeJsonPublicFunction("vote", { roadmapItemId })
}
