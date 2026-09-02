import {
  parseAdvertisingSnapshot,
  parseHydratedAdvertisingSnapshot,
  type AdvertisingSnapshot,
  type HydratedAdvertisingSnapshot,
} from "./advertising-sync-model.ts"

const BUCKET = "roadmap-images"
const MAX_OBJECT_BYTES = 5_000_000

export type AdvertisingStorageObject = {
  bytes: Uint8Array
  contentType: string
}

export type AdvertisingStorageDependencies = {
  downloadSource(path: string): Promise<AdvertisingStorageObject>
  downloadTarget(path: string): Promise<AdvertisingStorageObject | null>
  uploadTarget(
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>
  removeTarget(paths: string[]): Promise<void>
}

function storageError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function safeStorageError(error: unknown): Error & { code: string } {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["IMAGE_CONFLICT", "IMAGE_UNAVAILABLE", "IMAGE_CLEANUP_FAILED"].includes(
      String(error.code),
    )
  ) {
    return error as Error & { code: string }
  }
  return storageError("IMAGE_UNAVAILABLE", "广告系统图片暂时不可用")
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function normalizedMime(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase()
}

function encodeStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total >= MAX_OBJECT_BYTES) {
      await reader.cancel().catch(() => {})
      throw storageError("IMAGE_UNAVAILABLE", "图片对象超过 5MB 上限")
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function objectUrl(baseUrl: string, path: string): string {
  return new URL(
    `/storage/v1/object/${BUCKET}/${encodeStoragePath(path)}`,
    baseUrl,
  ).toString()
}

function serverHeaders(secretKey: string): Headers {
  return new Headers({
    apikey: secretKey,
    authorization: `Bearer ${secretKey}`,
  })
}

export function createAdvertisingStorageDependencies({
  sourceUrl,
  sourceSecretKey,
  targetUrl,
  targetSecretKey,
  fetchImpl = fetch,
}: {
  sourceUrl: string
  sourceSecretKey: string
  targetUrl: string
  targetSecretKey: string
  fetchImpl?: typeof fetch
}): AdvertisingStorageDependencies {
  async function download(
    baseUrl: string,
    secretKey: string,
    path: string,
    allowMissing: boolean,
  ): Promise<AdvertisingStorageObject | null> {
    let response: Response
    try {
      response = await fetchImpl(objectUrl(baseUrl, path), {
        method: "GET",
        headers: serverHeaders(secretKey),
      })
    } catch {
      throw storageError("IMAGE_UNAVAILABLE", "图片对象读取失败")
    }
    if (allowMissing && response.status === 404) return null
    if (!response.ok) {
      throw storageError("IMAGE_UNAVAILABLE", "图片对象读取失败")
    }
    return {
      bytes: await readBoundedBody(response),
      contentType: normalizedMime(response.headers.get("content-type") ?? ""),
    }
  }

  return {
    async downloadSource(path) {
      const result = await download(sourceUrl, sourceSecretKey, path, false)
      if (!result) throw storageError("IMAGE_UNAVAILABLE", "源图片对象不存在")
      return result
    },
    downloadTarget(path) {
      return download(targetUrl, targetSecretKey, path, true)
    },
    async uploadTarget(path, bytes, contentType) {
      const headers = serverHeaders(targetSecretKey)
      headers.set("content-type", contentType)
      headers.set("x-upsert", "false")
      const body = new Uint8Array(bytes.byteLength)
      body.set(bytes)
      let response: Response
      try {
        response = await fetchImpl(objectUrl(targetUrl, path), {
          method: "POST",
          headers,
          body: body.buffer,
        })
      } catch {
        throw storageError("IMAGE_UNAVAILABLE", "目标图片上传失败")
      }
      if (!response.ok) {
        throw storageError("IMAGE_UNAVAILABLE", "目标图片上传失败")
      }
    },
    async removeTarget(paths) {
      if (paths.length === 0) return
      const headers = serverHeaders(targetSecretKey)
      headers.set("content-type", "application/json")
      let response: Response
      try {
        response = await fetchImpl(
          new URL(`/storage/v1/object/${BUCKET}`, targetUrl).toString(),
          {
            method: "DELETE",
            headers,
            body: JSON.stringify({ prefixes: paths }),
          },
        )
      } catch {
        throw storageError("IMAGE_CLEANUP_FAILED", "目标图片补偿清理失败")
      }
      if (!response.ok) {
        throw storageError("IMAGE_CLEANUP_FAILED", "目标图片补偿清理失败")
      }
    },
  }
}

export async function compensateUploadedImages(
  paths: string[],
  dependencies: Pick<AdvertisingStorageDependencies, "removeTarget">,
): Promise<void> {
  if (paths.length === 0) return
  try {
    await dependencies.removeTarget([...paths].reverse())
  } catch {
    throw storageError("IMAGE_CLEANUP_FAILED", "目标图片补偿清理失败")
  }
}

export async function prepareAdvertisingImages(
  input: unknown,
  dependencies: AdvertisingStorageDependencies,
): Promise<{
  snapshot: HydratedAdvertisingSnapshot
  uploadedPaths: string[]
}> {
  const snapshot: AdvertisingSnapshot = parseAdvertisingSnapshot(input)
  const hydratedImages: Array<
    AdvertisingSnapshot["images"][number] & { sha256: string }
  > = new Array(snapshot.images.length)
  const attemptedUploads: string[] = []
  const successfulUploads: string[] = []
  let cursor = 0
  let failure: (Error & { code: string }) | null = null

  async function processImage(index: number) {
    const image = snapshot.images[index]
    const source = await dependencies.downloadSource(image.storagePath)
    if (
      source.bytes.byteLength !== image.sizeBytes ||
      normalizedMime(source.contentType) !== image.mimeType
    ) {
      throw storageError("IMAGE_UNAVAILABLE", "源图片元数据不一致")
    }
    const sourceHash = await sha256(source.bytes)
    const target = await dependencies.downloadTarget(image.storagePath)
    if (target) {
      const targetHash = await sha256(target.bytes)
      if (
        target.bytes.byteLength !== image.sizeBytes ||
        normalizedMime(target.contentType) !== image.mimeType ||
        targetHash !== sourceHash
      ) {
        throw storageError("IMAGE_CONFLICT", "目标图片路径存在内容冲突")
      }
    } else {
      attemptedUploads.push(image.storagePath)
      await dependencies.uploadTarget(
        image.storagePath,
        source.bytes,
        image.mimeType,
      )
      successfulUploads.push(image.storagePath)
    }
    hydratedImages[index] = { ...image, sha256: sourceHash }
  }

  async function worker() {
    while (!failure) {
      const index = cursor
      cursor += 1
      if (index >= snapshot.images.length) return
      try {
        await processImage(index)
      } catch (error) {
        failure = safeStorageError(error)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(3, snapshot.images.length) }, () => worker()),
  )

  if (failure) {
    try {
      await compensateUploadedImages(attemptedUploads, dependencies)
    } catch (cleanupError) {
      throw safeStorageError(cleanupError)
    }
    throw failure
  }

  return {
    snapshot: parseHydratedAdvertisingSnapshot({
      ...snapshot,
      images: hydratedImages,
    }),
    uploadedPaths: successfulUploads,
  }
}
