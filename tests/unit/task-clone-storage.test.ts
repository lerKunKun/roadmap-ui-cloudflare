import { describe, expect, it } from "vitest"

import {
  copyImageObjects,
  hydrateImageHashes,
  removeCopiedObjects,
} from "../../scripts/task-clone/storage.mjs"

const firstBytes = new TextEncoder().encode("hello")
const secondBytes = new TextEncoder().encode("world")
const SOURCE_URL = "https://abcdefghijklmnopqrst.supabase.co"
const TARGET_URL = "https://bcdefghijklmnopqrstu.supabase.co"

function manifestWithImages() {
  return {
    version: 1,
    capturedAt: "2026-09-01T06:00:00.000Z",
    sourceProjectRef: "abcdefghijklmnopqrst",
    projects: [],
    items: [],
    histories: [],
    images: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        roadmapItemId: "20000000-0000-4000-8000-000000000001",
        storagePath:
          "suggestions/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg",
        mimeType: "image/jpeg",
        sizeBytes: firstBytes.byteLength,
        width: 1,
        height: 1,
        createdAt: "2026-08-25T00:01:00.000Z",
        sha256: null as string | null,
      },
      {
        id: "30000000-0000-4000-8000-000000000002",
        roadmapItemId: "20000000-0000-4000-8000-000000000002",
        storagePath:
          "suggestions/20000000-0000-4000-8000-000000000002/30000000-0000-4000-8000-000000000002.png",
        mimeType: "image/png",
        sizeBytes: secondBytes.byteLength,
        width: 1,
        height: 1,
        createdAt: "2026-08-25T00:02:00.000Z",
        sha256: null,
      },
    ],
  }
}

describe("task clone storage copy", () => {
  it("hydrates immutable SHA-256 values from verified source bytes", async () => {
    const manifest = manifestWithImages()
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const bytes = request.url.endsWith(".jpg") ? firstBytes : secondBytes
      const type = request.url.endsWith(".jpg") ? "image/jpeg" : "image/png"
      return new Response(bytes, {
        headers: { "content-type": type, "content-length": String(bytes.length) },
      })
    }

    const hydrated = await hydrateImageHashes({
      manifest,
      source: { url: SOURCE_URL, secretKey: "source-secret" },
      fetchImpl,
    })

    expect(hydrated).not.toBe(manifest)
    expect(manifest.images[0].sha256).toBeNull()
    expect(
      hydrated.images.map((image: { sha256: string | null }) => image.sha256),
    ).toEqual([
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
    ])
    expect(requests[0].headers.get("authorization")).toBe("Bearer source-secret")
    expect(requests[0].url).toContain(
      "/storage/v1/object/roadmap-images/suggestions/20000000-0000-4000-8000-000000000001/",
    )
  })

  it("marks a missing source object as a stale snapshot", async () => {
    const fetchImpl = async () => new Response(null, { status: 404 })

    await expect(
      hydrateImageHashes({
        manifest: manifestWithImages(),
        source: { url: SOURCE_URL, secretKey: "source-secret" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_SNAPSHOT_STALE" })
  })

  it("rejects source MIME and length mismatches", async () => {
    const fetchImpl = async () =>
      new Response(firstBytes, {
        headers: { "content-type": "image/png", "content-length": "5" },
      })

    await expect(
      hydrateImageHashes({
        manifest: { ...manifestWithImages(), images: [manifestWithImages().images[0]] },
        source: { url: SOURCE_URL, secretKey: "source-secret" },
        fetchImpl,
      }),
    ).rejects.toThrow("源图片元数据不一致")
  })

  it("refuses to overwrite an existing target object", async () => {
    const manifest = manifestWithImages()
    manifest.images[0].sha256 =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    manifest.images = [manifest.images[0]]
    const methods: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      methods.push(request.method)
      return new Response(null, { status: 200 })
    }

    await expect(
      copyImageObjects({
        manifest,
        source: { url: SOURCE_URL, secretKey: "source-secret" },
        target: { url: TARGET_URL, secretKey: "target-secret" },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TARGET_OBJECT_EXISTS" })
    expect(methods).toEqual(["HEAD"])
  })

  it("cleans uploaded target objects in reverse order after a later failure", async () => {
    const hydrated = await hydrateImageHashes({
      manifest: manifestWithImages(),
      source: { url: SOURCE_URL, secretKey: "source-secret" },
      fetchImpl: async (input) => {
        const url = String(input)
        const bytes = url.endsWith(".jpg") ? firstBytes : secondBytes
        const type = url.endsWith(".jpg") ? "image/jpeg" : "image/png"
        return new Response(bytes, {
          headers: { "content-type": type, "content-length": String(bytes.length) },
        })
      },
    })
    const operations: string[] = []
    let uploads = 0
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      operations.push(`${request.method} ${request.url.split("/").at(-1)}`)
      if (request.method === "HEAD") return new Response(null, { status: 404 })
      if (request.url.startsWith(SOURCE_URL)) {
        const bytes = request.url.endsWith(".jpg") ? firstBytes : secondBytes
        const type = request.url.endsWith(".jpg") ? "image/jpeg" : "image/png"
        return new Response(bytes, {
          headers: { "content-type": type, "content-length": String(bytes.length) },
        })
      }
      if (request.method === "POST") {
        uploads += 1
        return uploads === 1
          ? new Response("{}", { status: 200 })
          : new Response("failed", { status: 500 })
      }
      return new Response(null, { status: 200 })
    }

    await expect(
      copyImageObjects({
        manifest: hydrated,
        source: { url: SOURCE_URL, secretKey: "source-secret" },
        target: { url: TARGET_URL, secretKey: "target-secret" },
        fetchImpl,
      }),
    ).rejects.toThrow("目标图片复制失败")

    expect(operations.filter((operation) => operation.startsWith("DELETE"))).toEqual([
      "DELETE 30000000-0000-4000-8000-000000000001.jpg",
    ])
  })

  it("independently refuses copying to or deleting from the protected source", async () => {
    const manifest = manifestWithImages()
    manifest.images[0].sha256 = "a".repeat(64)
    manifest.images = [manifest.images[0]]

    await expect(
      copyImageObjects({
        manifest,
        source: { url: SOURCE_URL, secretKey: "source-secret" },
        target: { url: SOURCE_URL, secretKey: "source-secret" },
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toThrow("拒绝修改源 Storage")

    await expect(
      removeCopiedObjects({
        paths: [manifest.images[0].storagePath],
        target: { url: SOURCE_URL, secretKey: "source-secret" },
        protectedSource: { url: SOURCE_URL, secretKey: "source-secret" },
        fetchImpl: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toThrow("拒绝修改源 Storage")
  })
})
