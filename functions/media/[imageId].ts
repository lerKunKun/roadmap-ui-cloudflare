const MAX_IMAGE_BYTES = 5_000_000
const SUCCESS_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400"
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"])

export interface MediaEnv {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_SECRET_KEY: string
}

export interface PublicImageRecord {
  id: string
  storage_path: string
  mime_type: string
  size_bytes: number
}

export interface MediaContext {
  request: Request
  params: { imageId?: string | string[] }
  env: MediaEnv
  waitUntil(promise: Promise<unknown>): void
}

export interface MediaDependencies {
  cacheMatch(request: Request): Promise<Response | undefined>
  cachePut(request: Request, response: Response): Promise<void>
  lookupPublicImage(
    id: string,
    env: MediaEnv
  ): Promise<PublicImageRecord | null>
  downloadPrivateImage(path: string, env: MediaEnv): Promise<Response>
}

interface RuntimeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

type SupabaseDependencies = Pick<
  MediaDependencies,
  "lookupPublicImage" | "downloadPrivateImage"
>

function errorResponse(status: number, message: string, allowGet = false) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  })

  if (allowGet) {
    headers.set("Allow", "GET")
  }

  return new Response(message, { status, headers })
}

function hasRuntimeEnvironment(env: MediaEnv) {
  return (
    typeof env?.SUPABASE_URL === "string" &&
    env.SUPABASE_URL.trim().length > 0 &&
    typeof env.SUPABASE_PUBLISHABLE_KEY === "string" &&
    env.SUPABASE_PUBLISHABLE_KEY.trim().length > 0 &&
    typeof env.SUPABASE_SECRET_KEY === "string" &&
    env.SUPABASE_SECRET_KEY.trim().length > 0
  )
}

function isPublicImageRecord(
  record: PublicImageRecord,
  requestedId: string
): record is PublicImageRecord {
  const pathSegments =
    typeof record?.storage_path === "string"
      ? record.storage_path.split("/")
      : []

  return (
    record?.id === requestedId &&
    pathSegments.length > 0 &&
    pathSegments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".."
    ) &&
    ALLOWED_MIME_TYPES.has(record.mime_type) &&
    Number.isSafeInteger(record.size_bytes) &&
    record.size_bytes > 0 &&
    record.size_bytes < MAX_IMAGE_BYTES
  )
}

function hasVerifiedOriginMetadata(
  response: Response,
  record: PublicImageRecord
) {
  if (
    response.status !== 200 ||
    response.body === null ||
    response.headers.get("Content-Type") !== record.mime_type
  ) {
    return false
  }

  const contentLengthHeader = response.headers.get("Content-Length")
  if (contentLengthHeader === null || !/^[0-9]+$/.test(contentLengthHeader)) {
    return false
  }

  const contentLength = Number(contentLengthHeader)
  return (
    Number.isFinite(contentLength) &&
    Number.isSafeInteger(contentLength) &&
    contentLength > 0 &&
    contentLength < MAX_IMAGE_BYTES &&
    contentLength === record.size_bytes
  )
}

function successfulResponse(response: Response, cacheStatus: "HIT" | "MISS") {
  const headers = new Headers(response.headers)
  headers.set("X-Roadmap-Cache", cacheStatus)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function handleMediaRequest(
  context: MediaContext,
  dependencies: MediaDependencies
): Promise<Response> {
  if (context.request.method !== "GET") {
    return errorResponse(405, "不支持此请求", true)
  }

  const imageId = context.params.imageId
  if (typeof imageId !== "string" || !UUID_PATTERN.test(imageId)) {
    return errorResponse(400, "图片地址无效")
  }

  const requestUrl = new URL(context.request.url)
  if (requestUrl.searchParams.size > 0) {
    return errorResponse(400, "图片地址无效")
  }

  const cacheRequest = new Request(requestUrl.origin + requestUrl.pathname)

  try {
    const cachedResponse = await dependencies.cacheMatch(cacheRequest)
    if (cachedResponse) {
      return successfulResponse(cachedResponse.clone(), "HIT")
    }

    if (!hasRuntimeEnvironment(context.env)) {
      return errorResponse(503, "图片服务暂不可用")
    }

    const record = await dependencies.lookupPublicImage(imageId, context.env)
    if (record === null) {
      return errorResponse(404, "图片不存在")
    }

    if (!isPublicImageRecord(record, imageId)) {
      return errorResponse(502, "图片服务暂不可用")
    }

    const originResponse = await dependencies.downloadPrivateImage(
      record.storage_path,
      context.env
    )
    if (!hasVerifiedOriginMetadata(originResponse, record)) {
      return errorResponse(502, "图片服务暂不可用")
    }

    const headers = new Headers({
      "Cache-Control": SUCCESS_CACHE_CONTROL,
      "Content-Disposition": "inline",
      "Content-Length": String(record.size_bytes),
      "Content-Type": record.mime_type,
      "X-Content-Type-Options": "nosniff",
    })

    const cacheableResponse = new Response(originResponse.body, {
      status: 200,
      headers,
    })
    const storedResponse = cacheableResponse.clone()
    const cacheWrite = Promise.resolve()
      .then(() => dependencies.cachePut(cacheRequest, storedResponse))
      .catch(() => undefined)
    context.waitUntil(cacheWrite)

    return successfulResponse(cacheableResponse, "MISS")
  } catch {
    return errorResponse(502, "图片服务暂不可用")
  }
}

function getRuntimeCache(): RuntimeCache {
  return (
    globalThis as typeof globalThis & {
      caches: { default: RuntimeCache }
    }
  ).caches.default
}

function encodeStoragePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}

function createSupabaseDependencies(): SupabaseDependencies {
  return {
    async lookupPublicImage(id, env) {
      const url =
        `${env.SUPABASE_URL}/rest/v1/roadmap_item_images_public` +
        `?id=eq.${id}&select=id,storage_path,mime_type,size_bytes&limit=1`
      const response = await fetch(url, {
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
        },
      })

      if (!response.ok) {
        throw new Error("public image lookup failed")
      }

      const records = (await response.json()) as unknown
      if (!Array.isArray(records)) {
        throw new Error("public image lookup returned invalid data")
      }

      return (records[0] as PublicImageRecord | undefined) ?? null
    },
    downloadPrivateImage(path, env) {
      const url =
        `${env.SUPABASE_URL}/storage/v1/object/roadmap-images/` +
        encodeStoragePath(path)
      return fetch(url, {
        headers: {
          apikey: env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        },
      })
    },
  }
}

function createProductionDependencies(): MediaDependencies {
  let supabaseDependencies: SupabaseDependencies | undefined
  const getSupabaseDependencies = () => {
    supabaseDependencies ??= createSupabaseDependencies()
    return supabaseDependencies
  }

  return {
    cacheMatch(request) {
      return getRuntimeCache().match(request)
    },
    cachePut(request, response) {
      return getRuntimeCache().put(request, response)
    },
    lookupPublicImage(id, env) {
      return getSupabaseDependencies().lookupPublicImage(id, env)
    },
    downloadPrivateImage(path, env) {
      return getSupabaseDependencies().downloadPrivateImage(path, env)
    },
  }
}

export function onRequest(context: MediaContext): Promise<Response> {
  return handleMediaRequest(context, createProductionDependencies())
}
