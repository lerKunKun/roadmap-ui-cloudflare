import { createHash } from "node:crypto"

class CloneStorageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "CloneStorageError"
    this.code = code
  }
}

function objectUrl(projectUrl, storagePath) {
  const encodedPath = storagePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${projectUrl.replace(/\/$/, "")}/storage/v1/object/roadmap-images/${encodedPath}`
}

function projectRefFromUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("Supabase Storage URL 无效")
  }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)
  if (url.protocol !== "https:" || !match || url.pathname !== "/") {
    throw new Error("Supabase Storage URL 无效")
  }
  return match[1]
}

function assertCopyIdentity(manifest, source, target) {
  const sourceRef = projectRefFromUrl(source.url)
  const targetRef = projectRefFromUrl(target.url)
  if (sourceRef !== manifest.sourceProjectRef) {
    throw new Error("源 Storage 与复制清单不匹配")
  }
  if (targetRef === sourceRef || target.secretKey === source.secretKey) {
    throw new Error("拒绝修改源 Storage")
  }
}

function assertDeleteIdentity(target, protectedSource) {
  const targetRef = projectRefFromUrl(target.url)
  const sourceRef = projectRefFromUrl(protectedSource.url)
  if (targetRef === sourceRef || target.secretKey === protectedSource.secretKey) {
    throw new Error("拒绝修改源 Storage")
  }
}

function storageHeaders(secretKey, extra = {}) {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "User-Agent": "task-roadmap-clone/1.0",
    ...extra,
  }
}

async function readVerifiedImage({ image, source, fetchImpl }) {
  const response = await fetchImpl(objectUrl(source.url, image.storagePath), {
    method: "GET",
    headers: storageHeaders(source.secretKey),
  })
  if (response.status === 404) {
    throw new CloneStorageError(
      "SOURCE_SNAPSHOT_STALE",
      "源图片在快照后已不存在，需要重新获取快照",
    )
  }
  if (!response.ok) {
    throw new CloneStorageError("SOURCE_IMAGE_READ_FAILED", "源图片读取失败")
  }

  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim()
  const declaredLength = response.headers.get("content-length")
  if (
    mimeType !== image.mimeType ||
    (declaredLength !== null && Number(declaredLength) !== image.sizeBytes)
  ) {
    throw new CloneStorageError("SOURCE_IMAGE_MISMATCH", "源图片元数据不一致")
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== image.sizeBytes || bytes.byteLength >= 5_000_000) {
    throw new CloneStorageError("SOURCE_IMAGE_MISMATCH", "源图片元数据不一致")
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return { bytes, sha256 }
}

export async function hydrateImageHashes({
  manifest,
  source,
  expectedProjectRef = manifest.sourceProjectRef,
  fetchImpl = fetch,
}) {
  if (expectedProjectRef && projectRefFromUrl(source.url) !== expectedProjectRef) {
    throw new Error("Storage 读取项目与已验证项目不匹配")
  }
  const images = []
  for (const image of manifest.images) {
    const { sha256 } = await readVerifiedImage({ image, source, fetchImpl })
    images.push({ ...image, sha256 })
  }
  return structuredClone({ ...manifest, images })
}

export async function removeCopiedObjects({
  paths,
  target,
  protectedSource,
  fetchImpl = fetch,
}) {
  assertDeleteIdentity(target, protectedSource)
  const failures = []
  for (const path of [...paths].reverse()) {
    try {
      const response = await fetchImpl(objectUrl(target.url, path), {
        method: "DELETE",
        headers: storageHeaders(target.secretKey),
      })
      if (!response.ok && response.status !== 404) failures.push(path)
    } catch {
      failures.push(path)
    }
  }
  if (failures.length > 0) {
    throw new CloneStorageError(
      "TARGET_CLEANUP_FAILED",
      `目标图片清理失败（${failures.length} 个对象）`,
    )
  }
}

export async function copyImageObjects({
  manifest,
  source,
  target,
  fetchImpl = fetch,
}) {
  assertCopyIdentity(manifest, source, target)
  for (const image of manifest.images) {
    if (!/^[a-f0-9]{64}$/.test(image.sha256 ?? "")) {
      throw new CloneStorageError("IMAGE_HASH_MISSING", "复制清单缺少图片校验值")
    }
    const response = await fetchImpl(objectUrl(target.url, image.storagePath), {
      method: "HEAD",
      headers: storageHeaders(target.secretKey),
    })
    if (response.ok) {
      throw new CloneStorageError(
        "TARGET_OBJECT_EXISTS",
        "目标图片对象已存在，拒绝覆盖",
      )
    }
    if (response.status !== 404) {
      throw new CloneStorageError("TARGET_OBJECT_CHECK_FAILED", "目标图片预检失败")
    }
  }

  const uploadedPaths = []
  try {
    for (const image of manifest.images) {
      const { bytes, sha256 } = await readVerifiedImage({ image, source, fetchImpl })
      if (sha256 !== image.sha256) {
        throw new CloneStorageError(
          "SOURCE_SNAPSHOT_STALE",
          "源图片内容在快照后发生变化，需要重新获取快照",
        )
      }
      const response = await fetchImpl(objectUrl(target.url, image.storagePath), {
        method: "POST",
        headers: storageHeaders(target.secretKey, {
          "content-type": image.mimeType,
          "content-length": String(bytes.byteLength),
          "x-upsert": "false",
        }),
        body: bytes,
      })
      if (!response.ok) {
        throw new CloneStorageError("TARGET_COPY_FAILED", "目标图片复制失败")
      }
      uploadedPaths.push(image.storagePath)
    }
  } catch (error) {
    try {
      await removeCopiedObjects({
        paths: uploadedPaths,
        target,
        protectedSource: source,
        fetchImpl,
      })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error.message}；${cleanupError.message}`,
      )
    }
    throw error
  }

  return { uploadedPaths: [...uploadedPaths] }
}
