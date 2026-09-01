import { createHash, randomBytes } from "node:crypto"
import { open, readFile, rename, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const STORAGE_PATH_PATTERN =
  /^suggestions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png)$/

export const TASK_COPY_RECEIPT_FILE = ".env.task.copy.local"
export const TASK_AMBIGUITY_RECEIPT_FILE = ".env.task.copy-ambiguous.local"
export const TASK_SMOKE_RECEIPT_FILE = ".env.task.smoke.local"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function digestRows(rows) {
  const normalized = rows
    .map((row) => JSON.stringify(canonical(row)))
    .sort()
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

function iso(value) {
  return new Date(value).toISOString()
}

export function datasetDigests(value, objectHashes = {}) {
  const projects = (value.projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    projectUrl: project.projectUrl ?? null,
    sortOrder: Number(project.sortOrder),
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  }))
  const items = (value.items ?? []).map((item) => ({
    id: item.id,
    projectId: item.projectId,
    title: item.title,
    description: item.description,
    status: item.status,
    sortOrder: Number(item.sortOrder),
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
    voteBaseline: String(item.voteBaseline),
  }))
  const histories = (value.histories ?? []).map((history) => ({
    roadmapItemId: history.roadmapItemId,
    fromStatus: history.fromStatus ?? null,
    toStatus: history.toStatus,
    changedAt: iso(history.changedAt),
  }))
  const images = (value.images ?? []).map((image) => ({
    id: image.id,
    roadmapItemId: image.roadmapItemId,
    storagePath: image.storagePath,
    mimeType: image.mimeType,
    sizeBytes: Number(image.sizeBytes),
    width: Number(image.width),
    height: Number(image.height),
    createdAt: iso(image.createdAt),
  }))
  const objects = Array.isArray(value.storageObjects)
    ? value.storageObjects.map((object) => ({
        storagePath: object.name,
        sha256: objectHashes[object.name],
        sizeBytes: Number(object.sizeBytes),
        mimeType: object.mimeType,
      }))
    : (value.images ?? []).map((image) => ({
        storagePath: image.storagePath,
        sha256: image.sha256 ?? objectHashes[image.storagePath],
        sizeBytes: Number(image.sizeBytes),
        mimeType: image.mimeType,
      }))
  return {
    projects: digestRows(projects),
    items: digestRows(items),
    histories: digestRows(histories),
    images: digestRows(images),
    objects: digestRows(objects),
  }
}

export function manifestDigest(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex")
}

export function objectDigest(images) {
  const objects = [...images]
    .map((image) => ({
      storagePath: image.storagePath,
      sha256: image.sha256,
      sizeBytes: Number(image.sizeBytes),
      mimeType: image.mimeType,
    }))
    .sort((left, right) => left.storagePath.localeCompare(right.storagePath))
  return createHash("sha256")
    .update(JSON.stringify(canonical(objects)))
    .digest("hex")
}

export function createCopyReceipt({ manifest, targetProjectRef, appCommit }) {
  if (!PROJECT_REF_PATTERN.test(manifest?.sourceProjectRef ?? "")) {
    throw new Error("复制回执的源项目无效")
  }
  if (!PROJECT_REF_PATTERN.test(targetProjectRef ?? "")) {
    throw new Error("复制回执的目标项目无效")
  }
  if (manifest.sourceProjectRef === targetProjectRef) {
    throw new Error("复制回执的源目标项目不能相同")
  }
  if (!COMMIT_PATTERN.test(appCommit ?? "")) throw new Error("复制回执的提交无效")
  for (const field of ["projects", "items", "histories", "images"]) {
    if (!Array.isArray(manifest?.[field])) throw new Error(`复制回执缺少 ${field}`)
  }
  const digests = datasetDigests(manifest)
  return {
    version: 1,
    sourceProjectRef: manifest.sourceProjectRef,
    targetProjectRef,
    manifestDigest: manifestDigest(manifest),
    objectDigest: objectDigest(manifest.images),
    datasetDigests: digests,
    appCommit,
    capturedAt: manifest.capturedAt,
    counts: {
      projects: manifest.projects.length,
      items: manifest.items.length,
      histories: manifest.histories.length,
      images: manifest.images.length,
    },
    objects: [...manifest.images]
      .map((image) => ({
        storagePath: image.storagePath,
        sha256: image.sha256,
        sizeBytes: Number(image.sizeBytes),
        mimeType: image.mimeType,
      }))
      .sort((left, right) => left.storagePath.localeCompare(right.storagePath)),
  }
}

export function validateCopyReceipt(value) {
  return Boolean(
    value?.version === 1 &&
      PROJECT_REF_PATTERN.test(value.sourceProjectRef ?? "") &&
      PROJECT_REF_PATTERN.test(value.targetProjectRef ?? "") &&
      value.sourceProjectRef !== value.targetProjectRef &&
      SHA256_PATTERN.test(value.manifestDigest ?? "") &&
      SHA256_PATTERN.test(value.objectDigest ?? "") &&
      ["projects", "items", "histories", "images", "objects"].every((field) =>
        SHA256_PATTERN.test(value.datasetDigests?.[field] ?? ""),
      ) &&
      COMMIT_PATTERN.test(value.appCommit ?? "") &&
      Number.isFinite(Date.parse(value.capturedAt)) &&
      ["projects", "items", "histories", "images"].every(
        (field) => Number.isInteger(value.counts?.[field]) && value.counts[field] >= 0,
      ) &&
      Array.isArray(value.objects) &&
      value.objects.length === value.counts.images &&
      value.objects.every(
        (object) =>
          STORAGE_PATH_PATTERN.test(object.storagePath ?? "") &&
          SHA256_PATTERN.test(object.sha256 ?? "") &&
          Number.isInteger(object.sizeBytes) &&
          object.sizeBytes > 0 &&
          object.sizeBytes < 5_000_000 &&
          ["image/jpeg", "image/png"].includes(object.mimeType),
      ),
  )
}

export function copyReceiptMatchesManifest(receipt, manifest) {
  if (!validateCopyReceipt(receipt)) return false
  const expected = createCopyReceipt({
    manifest,
    targetProjectRef: receipt.targetProjectRef,
    appCommit: receipt.appCommit,
  })
  return JSON.stringify(canonical(receipt)) === JSON.stringify(canonical(expected))
}

export async function writeReceiptAtomic(path, value) {
  const destination = resolve(path)
  const temporary = resolve(
    dirname(destination),
    `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  )
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function readCopyReceipt(path = TASK_COPY_RECEIPT_FILE) {
  let value
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"))
  } catch {
    throw new Error("Task Roadmap 复制回执不存在或格式无效")
  }
  if (!validateCopyReceipt(value)) throw new Error("Task Roadmap 复制回执无效")
  return value
}

export async function readOptionalCopyReceipt(path) {
  try {
    await readFile(resolve(path), "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  return readCopyReceipt(path)
}

export async function removeReceipt(path) {
  await unlink(resolve(path)).catch((error) => {
    if (error?.code !== "ENOENT") throw error
  })
}

export function createSmokeReceipt({ baseUrl, targetProjectRef, appCommit, copyDigest }) {
  const url = new URL(baseUrl)
  if (
    url.protocol !== "https:" ||
    !["task-roadmap-ui.pages.dev", "task.telljax.com"].includes(url.hostname)
  ) {
    throw new Error("Task Roadmap 冒烟回执地址无效")
  }
  if (!PROJECT_REF_PATTERN.test(targetProjectRef ?? "")) {
    throw new Error("Task Roadmap 冒烟回执目标无效")
  }
  if (!COMMIT_PATTERN.test(appCommit ?? "") || !SHA256_PATTERN.test(copyDigest ?? "")) {
    throw new Error("Task Roadmap 冒烟回执版本无效")
  }
  return {
    version: 1,
    baseUrl: `${url.origin}/`,
    targetProjectRef,
    appCommit,
    copyDigest,
    completedAt: new Date().toISOString(),
  }
}

export async function readSmokeReceipt(path = TASK_SMOKE_RECEIPT_FILE) {
  let value
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"))
  } catch {
    throw new Error("Task Roadmap 冒烟回执不存在或格式无效")
  }
  let validBaseUrl = false
  try {
    const url = new URL(value?.baseUrl)
    validBaseUrl =
      url.href === `${url.origin}/` &&
      url.protocol === "https:" &&
      ["task-roadmap-ui.pages.dev", "task.telljax.com"].includes(url.hostname)
  } catch {
    validBaseUrl = false
  }
  if (
    value?.version !== 1 ||
    !validBaseUrl ||
    !PROJECT_REF_PATTERN.test(value.targetProjectRef ?? "") ||
    !COMMIT_PATTERN.test(value.appCommit ?? "") ||
    !SHA256_PATTERN.test(value.copyDigest ?? "") ||
    Number.isNaN(Date.parse(value.completedAt))
  ) {
    throw new Error("Task Roadmap 冒烟回执无效")
  }
  return value
}
