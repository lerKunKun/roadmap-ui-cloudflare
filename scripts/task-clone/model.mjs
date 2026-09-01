const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/
const STORAGE_PATH_PATTERN =
  /^suggestions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png)$/
const STATUSES = new Set([
  "pending",
  "approved",
  "in_progress",
  "completed",
  "rejected",
])
const FORBIDDEN_KEYS = new Set([
  "votes",
  "ip",
  "ip_hash",
  "suggestion_rate_limits",
  "suggestion_image_rate_limits",
  "auth",
  "password",
  "token",
  "secret",
  "salt",
])

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isIsoDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function findForbiddenKeys(value, errors, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) findForbiddenKeys(entry, errors, seen)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      errors.push(`复制清单包含禁止字段：${key}`)
    }
    findForbiddenKeys(child, errors, seen)
  }
}

function duplicateValues(rows, field) {
  const seen = new Set()
  const duplicates = new Set()
  for (const row of rows) {
    const value = row?.[field]
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return duplicates
}

export function validateCloneManifest(value) {
  const errors = []
  findForbiddenKeys(value, errors)
  if (!isObject(value)) return [...errors, "复制清单必须是对象"]

  if (value.version !== 1) errors.push("复制清单版本无效")
  if (!isIsoDate(value.capturedAt)) errors.push("复制清单时间无效")
  if (!PROJECT_REF_PATTERN.test(value.sourceProjectRef ?? "")) {
    errors.push("源 Supabase Project Ref 无效")
  }

  for (const field of ["projects", "items", "histories", "images"]) {
    if (!Array.isArray(value[field])) errors.push(`复制清单 ${field} 必须是数组`)
  }
  if (errors.some((error) => error.endsWith("必须是数组"))) return errors

  const projects = value.projects
  const items = value.items
  const histories = value.histories
  const images = value.images

  for (const duplicate of duplicateValues(projects, "id")) {
    errors.push(`项目 UUID 重复：${duplicate}`)
  }
  for (const duplicate of duplicateValues(projects, "slug")) {
    errors.push(`项目 slug 重复：${duplicate}`)
  }
  for (const project of projects) {
    if (!isObject(project) || !UUID_PATTERN.test(project.id ?? "")) {
      errors.push(`项目 UUID 无效：${project?.id ?? "未知"}`)
      continue
    }
    if (
      typeof project.name !== "string" ||
      project.name.trim().length < 1 ||
      project.name.trim().length > 80
    ) {
      errors.push(`项目 ${project.id} 的名称无效`)
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug ?? "")) {
      errors.push(`项目 ${project.id} 的 slug 无效`)
    }
    if (
      project.projectUrl !== null &&
      (typeof project.projectUrl !== "string" ||
        !project.projectUrl.startsWith("https://"))
    ) {
      errors.push(`项目 ${project.id} 的网址无效`)
    }
    if (!Number.isInteger(project.sortOrder)) {
      errors.push(`项目 ${project.id} 的排序无效`)
    }
    if (!isIsoDate(project.createdAt) || !isIsoDate(project.updatedAt)) {
      errors.push(`项目 ${project.id} 的时间无效`)
    }
  }

  const projectIds = new Set(projects.map((project) => project?.id))
  for (const duplicate of duplicateValues(items, "id")) {
    errors.push(`条目 UUID 重复：${duplicate}`)
  }
  for (const item of items) {
    if (!isObject(item) || !UUID_PATTERN.test(item.id ?? "")) {
      errors.push(`条目 UUID 无效：${item?.id ?? "未知"}`)
      continue
    }
    if (!projectIds.has(item.projectId)) {
      errors.push(`条目 ${item.id} 引用了不存在的项目`)
    }
    if (
      typeof item.title !== "string" ||
      item.title.trim().length < 2 ||
      item.title.trim().length > 120
    ) {
      errors.push(`条目 ${item.id} 的标题无效`)
    }
    if (typeof item.description !== "string" || item.description.length > 4000) {
      errors.push(`条目 ${item.id} 的说明无效`)
    }
    if (!STATUSES.has(item.status)) errors.push(`条目 ${item.id} 的状态无效`)
    if (!Number.isInteger(item.sortOrder)) errors.push(`条目 ${item.id} 的排序无效`)
    if (!isIsoDate(item.createdAt) || !isIsoDate(item.updatedAt)) {
      errors.push(`条目 ${item.id} 的时间无效`)
    }
    if (typeof item.voteBaseline !== "string" || !/^\d+$/.test(item.voteBaseline)) {
      errors.push(`条目 ${item.id} 的历史票数无效`)
    }
  }

  const itemIds = new Set(items.map((item) => item?.id))
  for (const history of histories) {
    if (!isObject(history) || !/^\d+$/.test(history.sourceOrder ?? "")) {
      errors.push("状态历史顺序无效")
      continue
    }
    if (!itemIds.has(history.roadmapItemId)) {
      errors.push(`状态历史 ${history.sourceOrder} 引用了不存在的条目`)
    }
    if (
      (history.fromStatus !== null && !STATUSES.has(history.fromStatus)) ||
      !STATUSES.has(history.toStatus) ||
      history.fromStatus === history.toStatus
    ) {
      errors.push(`状态历史 ${history.sourceOrder} 的状态无效`)
    }
    if (!isIsoDate(history.changedAt)) {
      errors.push(`状态历史 ${history.sourceOrder} 的时间无效`)
    }
  }

  for (const duplicate of duplicateValues(images, "id")) {
    errors.push(`图片 UUID 重复：${duplicate}`)
  }
  for (const duplicate of duplicateValues(images, "storagePath")) {
    errors.push(`图片路径重复：${duplicate}`)
  }
  for (const duplicate of duplicateValues(images, "roadmapItemId")) {
    errors.push(`条目图片关系重复：${duplicate}`)
  }
  for (const image of images) {
    if (!isObject(image) || !UUID_PATTERN.test(image.id ?? "")) {
      errors.push(`图片 UUID 无效：${image?.id ?? "未知"}`)
      continue
    }
    if (!itemIds.has(image.roadmapItemId)) {
      errors.push(`图片 ${image.id} 引用了不存在的条目`)
    }
    if (!STORAGE_PATH_PATTERN.test(image.storagePath ?? "")) {
      errors.push(`图片 ${image.id} 的路径无效`)
    }
    if (!new Set(["image/jpeg", "image/png"]).has(image.mimeType)) {
      errors.push(`图片 ${image.id} 的 MIME 无效`)
    }
    if (!Number.isInteger(image.sizeBytes) || image.sizeBytes < 1 || image.sizeBytes >= 5_000_000) {
      errors.push(`图片 ${image.id} 的字节数无效`)
    }
    if (
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.width > 12_000 ||
      image.height > 12_000 ||
      image.width * image.height > 40_000_000
    ) {
      errors.push(`图片 ${image.id} 的尺寸无效`)
    }
    if (!isIsoDate(image.createdAt)) errors.push(`图片 ${image.id} 的时间无效`)
    if (image.sha256 !== null && !/^[a-f0-9]{64}$/.test(image.sha256 ?? "")) {
      errors.push(`图片 ${image.id} 的 SHA-256 无效`)
    }
  }

  return [...new Set(errors)]
}

export function parseCloneManifest(value) {
  const errors = validateCloneManifest(value)
  if (errors.length > 0) {
    throw new Error(`复制清单无效（${errors.length} 项）：${errors.join("；")}`)
  }
  return structuredClone(value)
}
