import { z } from "zod"

import { listProjects, listRoadmapItems, mapProjectRow } from "@/features/roadmap/api"
import {
  createdDateTimestamp,
  isValidDateInput,
  localDateInputValue,
} from "@/features/roadmap/calendar-date"
import {
  isRoadmapStatus,
  type Project,
  type RoadmapItem,
  type RoadmapStatus,
} from "@/features/roadmap/types"
import { getSupabaseBrowserClient } from "@/lib/supabase/browser"

export interface ProjectInput {
  name: string
  slug: string
  projectUrl?: string | null
  sortOrder: number
}

export interface RoadmapItemInput {
  projectId: string
  title: string
  description: string
  status: RoadmapStatus
  sortOrder: number
  createdDate?: string
}

export interface AdminRoadmapImage {
  id: string
  signedUrl: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
}

interface AdminItemRow {
  id: string
  project_id: string
  title: string
  description: string
  status: string
  sort_order: number
  created_at: string
  updated_at: string
}

interface AdminImageMetadataRow {
  id: string
  roadmap_item_id: string
  storage_path: string
  mime_type: string
  size_bytes: number
  width: number
  height: number
}

const projectSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称").max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "项目标识只能使用小写字母、数字和连字符"),
  projectUrl: z.string().trim().max(2048).nullable().optional(),
  sortOrder: z.number().int().min(0),
})

const itemSchema = z.object({
  projectId: z.string().uuid("项目 ID 无效"),
  title: z.string().trim().min(2, "标题至少需要 2 个字符").max(120),
  description: z.string().trim().max(4000),
  status: z.enum([
    "pending",
    "approved",
    "in_progress",
    "completed",
    "rejected",
  ]),
  sortOrder: z.number().int().min(0),
  createdDate: z
    .string()
    .refine(isValidDateInput, "创建日期无效")
    .refine(
      (value) => value <= localDateInputValue(),
      "创建日期不能晚于今天"
    )
    .optional(),
})

function normalizeProjectUrl(value?: string | null): string | null {
  const cleanValue = value?.trim()
  if (!cleanValue) return null

  const candidate = /^https?:\/\//i.test(cleanValue)
    ? cleanValue
    : `https://${cleanValue}`

  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    return url.toString()
  } catch {
    throw new Error("项目网址无效")
  }
}

function projectPayload(input: ProjectInput) {
  const parsed = projectSchema.parse(input)
  return {
    name: parsed.name,
    slug: parsed.slug,
    project_url: normalizeProjectUrl(parsed.projectUrl),
    sort_order: parsed.sortOrder,
  }
}

function itemPayloadFromParsed(parsed: z.infer<typeof itemSchema>) {
  return {
    project_id: parsed.projectId,
    title: parsed.title,
    description: parsed.description,
    status: parsed.status,
    sort_order: parsed.sortOrder,
  }
}

function itemPayload(input: RoadmapItemInput) {
  return itemPayloadFromParsed(itemSchema.parse(input))
}

function createItemPayload(input: RoadmapItemInput) {
  const parsed = itemSchema.parse(input)
  const createdDate = parsed.createdDate ?? localDateInputValue()
  return {
    ...itemPayloadFromParsed(parsed),
    created_at: createdDateTimestamp(createdDate),
  }
}

function mapAdminItem(row: AdminItemRow): RoadmapItem {
  if (!isRoadmapStatus(row.status)) throw new Error("Roadmap 状态无效")
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    sortOrder: row.sort_order,
    voteCount: 0,
    hasImage: false,
    imageId: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function getAdminRoadmapImageMetadata(
  itemId: string
): Promise<AdminImageMetadataRow | null> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_item_images")
    .select("id,roadmap_item_id,storage_path,mime_type,size_bytes,width,height")
    .eq("roadmap_item_id", itemId)
    .maybeSingle()

  if (error) throw new Error("Roadmap 图片元数据加载失败")
  return data as AdminImageMetadataRow | null
}

export async function getAdminRoadmapItemImage(
  itemId: string
): Promise<AdminRoadmapImage | null> {
  const image = await getAdminRoadmapImageMetadata(itemId)
  if (!image) return null

  let signedUrlResult
  try {
    signedUrlResult = await getSupabaseBrowserClient()
      .storage.from("roadmap-images")
      .createSignedUrl(image.storage_path, 300)
  } catch {
    throw new Error("建议图片加载失败，请重试")
  }

  const { data, error } = signedUrlResult

  if (error || !data?.signedUrl) {
    throw new Error("建议图片加载失败，请重试")
  }

  return {
    id: image.id,
    signedUrl: data.signedUrl,
    mimeType: image.mime_type,
    sizeBytes: image.size_bytes,
    width: image.width,
    height: image.height,
  }
}

async function hydrateAdminItem(row: AdminItemRow): Promise<RoadmapItem> {
  const item = mapAdminItem(row)
  const image = await getAdminRoadmapImageMetadata(item.id)
  const imageIsPublic = !["pending", "rejected"].includes(item.status)

  return {
    ...item,
    hasImage: image !== null,
    imageId: image && imageIsPublic ? image.id : null,
  }
}

function mutationError(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return
  if (error.code === "23503") {
    throw new Error("请先删除或移动该项目中的 Roadmap 条目")
  }
  if (error.code === "23505") throw new Error("项目标识已存在")
  throw new Error(fallback)
}

function isStorageObjectNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "NoSuchKey"
  )
}

export const listAdminProjects = listProjects
export const listAdminRoadmapItems = listRoadmapItems

export async function createProject(input: ProjectInput): Promise<Project> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("projects")
    .insert(projectPayload(input))
    .select("id,name,slug,project_url,sort_order")
    .single()

  mutationError(error, "项目创建失败")
  const project = mapProjectRow(data as Parameters<typeof mapProjectRow>[0])
  return { ...project, sortOrder: await moveProject(project.id, input.sortOrder) }
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("projects")
    .update(projectPayload(input))
    .eq("id", id)
    .select("id,name,slug,project_url,sort_order")
    .single()

  mutationError(error, "项目更新失败")
  const project = mapProjectRow(data as Parameters<typeof mapProjectRow>[0])
  return { ...project, sortOrder: await moveProject(project.id, input.sortOrder) }
}

export async function moveProject(id: string, sortOrder: number): Promise<number> {
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw new Error("排序值无效")
  }

  const { data, error } = await getSupabaseBrowserClient().rpc("move_project", {
    target_project_id: id,
    target_sort_order: sortOrder,
  })
  mutationError(error, "项目排序失败")
  return Number(data)
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await getSupabaseBrowserClient()
    .from("projects")
    .delete()
    .eq("id", id)
  mutationError(error, "项目删除失败")
}

export async function createRoadmapItem(input: RoadmapItemInput): Promise<RoadmapItem> {
  const payload = createItemPayload(input)
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_items")
    .insert(payload)
    .select("id,project_id,title,description,status,sort_order,created_at,updated_at")
    .single()

  mutationError(error, "Roadmap 条目创建失败")
  return hydrateAdminItem(data as AdminItemRow)
}

export async function updateRoadmapItem(
  id: string,
  input: RoadmapItemInput,
): Promise<RoadmapItem> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_items")
    .update(itemPayload(input))
    .eq("id", id)
    .select("id,project_id,title,description,status,sort_order,created_at,updated_at")
    .single()

  mutationError(error, "Roadmap 条目更新失败")
  return hydrateAdminItem(data as AdminItemRow)
}

export async function deleteRoadmapItem(id: string): Promise<void> {
  const image = await getAdminRoadmapImageMetadata(id)

  if (image) {
    let storageError: unknown
    try {
      const result = await getSupabaseBrowserClient()
        .storage.from("roadmap-images")
        .remove([image.storage_path])
      storageError = result.error
    } catch {
      throw new Error("建议图片删除失败，Roadmap 条目已保留")
    }

    if (storageError && !isStorageObjectNotFound(storageError)) {
      throw new Error("建议图片删除失败，Roadmap 条目已保留")
    }
  }

  const { error } = await getSupabaseBrowserClient()
    .from("roadmap_items")
    .delete()
    .eq("id", id)
  mutationError(error, "Roadmap 条目删除失败")
}

export async function moveRoadmapItem(
  id: string,
  status: RoadmapStatus,
  sortOrder: number,
): Promise<void> {
  if (!isRoadmapStatus(status)) throw new Error("Roadmap 状态无效")
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw new Error("排序值无效")
  }

  const { error } = await getSupabaseBrowserClient().rpc(
    "move_roadmap_item",
    {
      target_item_id: id,
      target_status: status,
      target_sort_order: sortOrder,
    },
  )
  mutationError(error, "Roadmap 状态更新失败")
}
