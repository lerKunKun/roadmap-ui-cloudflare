import { afterEach, describe, expect, it, vi } from "vitest"

import {
  handleMediaRequest,
  onRequest,
  type MediaContext,
  type MediaDependencies,
  type MediaEnv,
  type PublicImageRecord,
} from "../../functions/media/[imageId]"

const IMAGE_ID = "123e4567-e89b-42d3-a456-426614174000"
const IMAGE_URL = `https://roadmap.example.com/media/${IMAGE_ID}`
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71])

const VALID_ENV: MediaEnv = {
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
}

const PUBLIC_IMAGE: PublicImageRecord = {
  id: IMAGE_ID,
  storage_path: `suggestions/${IMAGE_ID}/证明 图片.png`,
  mime_type: "image/png",
  size_bytes: IMAGE_BYTES.byteLength,
}

interface TestHarness {
  context: MediaContext
  waitUntilPromises: Promise<unknown>[]
}

function makeContext(
  options: {
    method?: string
    url?: string
    imageId?: string
    env?: Partial<MediaEnv>
  } = {}
): TestHarness {
  const waitUntilPromises: Promise<unknown>[] = []

  return {
    context: {
      request: new Request(options.url ?? IMAGE_URL, {
        method: options.method ?? "GET",
      }),
      params: { imageId: options.imageId ?? IMAGE_ID },
      env: { ...VALID_ENV, ...options.env },
      waitUntil(promise) {
        waitUntilPromises.push(promise)
      },
    },
    waitUntilPromises,
  }
}

function makeOriginResponse(
  options: {
    body?: BodyInit | null
    contentLength?: string | null
    contentType?: string
    status?: number
  } = {}
) {
  const headers = new Headers()

  if (options.contentLength !== null) {
    headers.set(
      "Content-Length",
      options.contentLength ?? String(IMAGE_BYTES.byteLength)
    )
  }
  headers.set("Content-Type", options.contentType ?? "image/png")

  return new Response(options.body ?? IMAGE_BYTES, {
    status: options.status ?? 200,
    headers,
  })
}

function makeDependencies(
  overrides: Partial<MediaDependencies> = {}
): MediaDependencies {
  return {
    cacheMatch: vi.fn().mockResolvedValue(undefined),
    cachePut: vi.fn().mockResolvedValue(undefined),
    lookupPublicImage: vi.fn().mockResolvedValue(PUBLIC_IMAGE),
    downloadPrivateImage: vi.fn().mockResolvedValue(makeOriginResponse()),
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("media Pages Function", () => {
  it("rejects non-GET requests without touching cache or origin", async () => {
    const { context } = makeContext({ method: "POST" })
    const dependencies = makeDependencies()

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("GET")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.cacheMatch).not.toHaveBeenCalled()
    expect(dependencies.lookupPublicImage).not.toHaveBeenCalled()
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
  })

  it("rejects malformed UUIDs without touching cache or origin", async () => {
    const { context } = makeContext({
      imageId: "not-a-uuid",
      url: "https://roadmap.example.com/media/not-a-uuid",
    })
    const dependencies = makeDependencies()

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.cacheMatch).not.toHaveBeenCalled()
    expect(dependencies.lookupPublicImage).not.toHaveBeenCalled()
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
  })

  it("rejects unexpected query parameters without touching cache or origin", async () => {
    const { context } = makeContext({ url: `${IMAGE_URL}?download=1` })
    const dependencies = makeDependencies()

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(400)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.cacheMatch).not.toHaveBeenCalled()
    expect(dependencies.lookupPublicImage).not.toHaveBeenCalled()
  })

  it.each([
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
  ] as const)("returns 503 when %s is missing", async (missingKey) => {
    const { context } = makeContext({ env: { [missingKey]: "" } })
    const dependencies = makeDependencies()

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(503)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.cacheMatch).toHaveBeenCalledOnce()
    expect(dependencies.lookupPublicImage).not.toHaveBeenCalled()
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
  })

  it("returns a cache HIT without performing public lookup or private download", async () => {
    const { context } = makeContext()
    const cached = new Response(IMAGE_BYTES, {
      headers: { "Content-Type": "image/png" },
    })
    const dependencies = makeDependencies({
      cacheMatch: vi.fn().mockResolvedValue(cached),
    })

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(IMAGE_BYTES)
    expect(response.headers.get("X-Roadmap-Cache")).toBe("HIT")
    expect(dependencies.lookupPublicImage).not.toHaveBeenCalled()
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
    expect(dependencies.cachePut).not.toHaveBeenCalled()
  })

  it("returns an uncached 404 when the public image record is absent", async () => {
    const { context } = makeContext()
    const dependencies = makeDependencies({
      lookupPublicImage: vi.fn().mockResolvedValue(null),
    })

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(404)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
    expect(dependencies.cachePut).not.toHaveBeenCalled()
  })

  it("streams a valid MISS, stores a neutral response, and sets success headers", async () => {
    const { context, waitUntilPromises } = makeContext({ url: `${IMAGE_URL}?` })
    const dependencies = makeDependencies()

    const response = await handleMediaRequest(context, dependencies)
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(IMAGE_BYTES)
    expect(response.headers.get("X-Roadmap-Cache")).toBe("MISS")
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=86400"
    )
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Disposition")).toBe("inline")
    expect(dependencies.downloadPrivateImage).toHaveBeenCalledOnce()
    expect(dependencies.cachePut).toHaveBeenCalledOnce()

    const [cacheRequest, storedResponse] = vi.mocked(dependencies.cachePut).mock
      .calls[0]
    expect(cacheRequest.url).toBe(IMAGE_URL)
    expect(storedResponse.headers.has("X-Roadmap-Cache")).toBe(false)
    expect(new Uint8Array(await storedResponse.arrayBuffer())).toEqual(
      IMAGE_BYTES
    )
  })

  it("strips Storage cookies and internal headers before returning or caching", async () => {
    const { context, waitUntilPromises } = makeContext()
    const originResponse = makeOriginResponse()
    originResponse.headers.set("Set-Cookie", "storage-session=secret; Secure")
    originResponse.headers.set("Sb-Request-Id", "private-upstream-request")
    originResponse.headers.set("Cf-Ray", "private-upstream-ray")
    const dependencies = makeDependencies({
      downloadPrivateImage: vi.fn().mockResolvedValue(originResponse),
    })

    const response = await handleMediaRequest(context, dependencies)
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(200)
    expect(response.headers.get("Set-Cookie")).toBeNull()
    expect(response.headers.get("Sb-Request-Id")).toBeNull()
    expect(response.headers.get("Cf-Ray")).toBeNull()

    const storedResponse = vi.mocked(dependencies.cachePut).mock.calls[0][1]
    expect(storedResponse.headers.get("Set-Cookie")).toBeNull()
    expect(storedResponse.headers.get("Sb-Request-Id")).toBeNull()
    expect(storedResponse.headers.get("Cf-Ray")).toBeNull()
  })

  it("does not fail a valid response when the asynchronous cache write rejects", async () => {
    const { context, waitUntilPromises } = makeContext()
    const dependencies = makeDependencies({
      cachePut: vi.fn().mockRejectedValue(new Error("cache unavailable")),
    })

    const response = await handleMediaRequest(context, dependencies)

    await expect(Promise.all(waitUntilPromises)).resolves.toBeDefined()
    expect(response.status).toBe(200)
    expect(response.headers.get("X-Roadmap-Cache")).toBe("MISS")
  })

  it("returns 502 without caching when origin MIME disagrees with metadata", async () => {
    const { context } = makeContext()
    const dependencies = makeDependencies({
      downloadPrivateImage: vi
        .fn()
        .mockResolvedValue(makeOriginResponse({ contentType: "image/jpeg" })),
    })

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(502)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.cachePut).not.toHaveBeenCalled()
  })

  it("returns 502 without exposing or caching a non-200 origin response", async () => {
    const { context } = makeContext()
    const dependencies = makeDependencies({
      downloadPrivateImage: vi.fn().mockResolvedValue(
        makeOriginResponse({
          body: "sensitive upstream details",
          contentLength: String("sensitive upstream details".length),
          contentType: "text/plain",
          status: 403,
        })
      ),
    })

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(502)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.text()).not.toContain("sensitive upstream details")
    expect(dependencies.cachePut).not.toHaveBeenCalled()
  })

  it.each([
    ["absent", null],
    ["invalid", "four"],
    ["oversized", "5000000"],
    ["metadata-mismatched", "5"],
  ])(
    "returns 502 for %s origin Content-Length",
    async (_caseName, contentLength) => {
      const { context } = makeContext()
      const dependencies = makeDependencies({
        downloadPrivateImage: vi
          .fn()
          .mockResolvedValue(makeOriginResponse({ contentLength })),
      })

      const response = await handleMediaRequest(context, dependencies)

      expect(response.status).toBe(502)
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(dependencies.cachePut).not.toHaveBeenCalled()
    }
  )

  it("rejects oversized metadata before downloading the private object", async () => {
    const { context } = makeContext()
    const dependencies = makeDependencies({
      lookupPublicImage: vi.fn().mockResolvedValue({
        ...PUBLIC_IMAGE,
        size_bytes: 5_000_000,
      }),
    })

    const response = await handleMediaRequest(context, dependencies)

    expect(response.status).toBe(502)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(dependencies.downloadPrivateImage).not.toHaveBeenCalled()
    expect(dependencies.cachePut).not.toHaveBeenCalled()
  })

  it("keeps production Supabase dependencies lazy on cache HIT", async () => {
    const cached = new Response(IMAGE_BYTES, {
      headers: { "Content-Type": "image/png" },
    })
    const cacheMatch = vi.fn().mockResolvedValue(cached)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubGlobal("caches", {
      default: { match: cacheMatch, put: vi.fn() },
    })
    const { context } = makeContext()

    const response = await onRequest(context)

    expect(response.headers.get("X-Roadmap-Cache")).toBe("HIT")
    expect(cacheMatch).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("serves a production cache HIT when Supabase runtime values are absent", async () => {
    const cached = new Response(IMAGE_BYTES, {
      headers: { "Content-Type": "image/png" },
    })
    const cacheMatch = vi.fn().mockResolvedValue(cached)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.stubGlobal("caches", {
      default: { match: cacheMatch, put: vi.fn() },
    })
    const { context } = makeContext({
      env: {
        SUPABASE_URL: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_SECRET_KEY: "",
      },
    })

    const response = await onRequest(context)

    expect(response.status).toBe(200)
    expect(response.headers.get("X-Roadmap-Cache")).toBe("HIT")
    expect(cacheMatch).toHaveBeenCalledOnce()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("uses the publishable key for exact public lookup and secret key for encoded private download", async () => {
    const cachePut = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("caches", {
      default: { match: vi.fn().mockResolvedValue(undefined), put: cachePut },
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([PUBLIC_IMAGE]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(makeOriginResponse())
    vi.stubGlobal("fetch", fetchSpy)
    const { context, waitUntilPromises } = makeContext()

    const response = await onRequest(context)
    await Promise.all(waitUntilPromises)

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const [lookupUrl, lookupInit] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(lookupUrl).toBe(
      `${VALID_ENV.SUPABASE_URL}/rest/v1/roadmap_item_images_public?id=eq.${IMAGE_ID}&select=id,storage_path,mime_type,size_bytes&limit=1`
    )
    expect(new Headers(lookupInit.headers).get("apikey")).toBe(
      VALID_ENV.SUPABASE_PUBLISHABLE_KEY
    )
    expect(new Headers(lookupInit.headers).get("Authorization")).not.toContain(
      VALID_ENV.SUPABASE_SECRET_KEY
    )

    const [downloadUrl, downloadInit] = fetchSpy.mock.calls[1] as [
      string,
      RequestInit,
    ]
    expect(downloadUrl).toBe(
      `${VALID_ENV.SUPABASE_URL}/storage/v1/object/roadmap-images/suggestions/${IMAGE_ID}/%E8%AF%81%E6%98%8E%20%E5%9B%BE%E7%89%87.png`
    )
    expect(new Headers(downloadInit.headers).get("Authorization")).toBe(
      `Bearer ${VALID_ENV.SUPABASE_SECRET_KEY}`
    )
  })
})
