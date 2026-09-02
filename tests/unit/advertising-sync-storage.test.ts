import { describe, expect, it } from "vitest"

import {
  createAdvertisingStorageDependencies,
  prepareAdvertisingImages,
} from "../../supabase/functions/_shared/advertising-sync-storage"

const PROJECT_ID = "91000000-0000-4000-8000-000000000001"

function snapshotWithImages(count = 1) {
  const items = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(12, "0")
    return {
      id: `92000000-0000-4000-8000-${suffix}`,
      projectId: PROJECT_ID,
      title: `图片条目 ${index + 1}`,
      description: "",
      status: "approved",
      sortOrder: index,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      voteBaseline: "0",
    }
  })
  return {
    version: 1,
    capturedAt: "2026-09-02T00:00:00.000Z",
    project: {
      id: PROJECT_ID,
      name: "广告系统",
      slug: "advertising-system",
      projectUrl: null,
      sortOrder: 0,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
    items,
    histories: [],
    images: items.map((item, index) => {
      const suffix = String(index + 1).padStart(12, "0")
      const imageId = `93000000-0000-4000-8000-${suffix}`
      return {
        id: imageId,
        roadmapItemId: item.id,
        storagePath: `suggestions/${item.id}/${imageId}.png`,
        mimeType: "image/png",
        sizeBytes: 5,
        width: 2,
        height: 2,
        createdAt: "2026-09-01T00:01:00.000Z",
      }
    }),
  }
}

const imageBytes = new TextEncoder().encode("image")

describe("advertising image preparation", () => {
  it("hashes and uploads a missing target object without overwrite", async () => {
    const uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }> = []
    const result = await prepareAdvertisingImages(snapshotWithImages(), {
      downloadSource: async () => ({ bytes: imageBytes, contentType: "image/png" }),
      downloadTarget: async () => null,
      uploadTarget: async (path, bytes, contentType) => {
        uploads.push({ path, bytes, contentType })
      },
      removeTarget: async () => {},
    })

    expect(result.uploadedPaths).toEqual([
      snapshotWithImages().images[0].storagePath,
    ])
    expect(result.snapshot.images[0].sha256).toBe(
      "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d",
    )
    expect(uploads).toEqual([
      {
        path: snapshotWithImages().images[0].storagePath,
        bytes: imageBytes,
        contentType: "image/png",
      },
    ])
  })

  it("reuses an existing target object only when bytes and MIME match", async () => {
    let uploads = 0
    const result = await prepareAdvertisingImages(snapshotWithImages(), {
      downloadSource: async () => ({ bytes: imageBytes, contentType: "image/png" }),
      downloadTarget: async () => ({ bytes: imageBytes, contentType: "image/png" }),
      uploadTarget: async () => {
        uploads += 1
      },
      removeTarget: async () => {},
    })

    expect(result.uploadedPaths).toEqual([])
    expect(uploads).toBe(0)
  })

  it("fails closed when an existing target path has different content", async () => {
    await expect(
      prepareAdvertisingImages(snapshotWithImages(), {
        downloadSource: async () => ({ bytes: imageBytes, contentType: "image/png" }),
        downloadTarget: async () => ({
          bytes: new TextEncoder().encode("other"),
          contentType: "image/png",
        }),
        uploadTarget: async () => {},
        removeTarget: async () => {},
      }),
    ).rejects.toMatchObject({ code: "IMAGE_CONFLICT" })
  })

  it.each([
    ["wrong MIME", { bytes: imageBytes, contentType: "image/jpeg" }],
    ["wrong byte length", { bytes: imageBytes.slice(0, 4), contentType: "image/png" }],
  ])("rejects source metadata mismatch: %s", async (_name, source) => {
    await expect(
      prepareAdvertisingImages(snapshotWithImages(), {
        downloadSource: async () => source,
        downloadTarget: async () => null,
        uploadTarget: async () => {},
        removeTarget: async () => {},
      }),
    ).rejects.toMatchObject({ code: "IMAGE_UNAVAILABLE" })
  })

  it("removes every attempted new object in reverse order after a later failure", async () => {
    const removed: string[][] = []
    const snapshot = snapshotWithImages(3)
    let uploadCount = 0

    await expect(
      prepareAdvertisingImages(snapshot, {
        downloadSource: async () => ({ bytes: imageBytes, contentType: "image/png" }),
        downloadTarget: async () => null,
        uploadTarget: async () => {
          uploadCount += 1
          if (uploadCount === 3) throw new Error("provider body must not escape")
        },
        removeTarget: async (paths) => {
          removed.push(paths)
        },
      }),
    ).rejects.toMatchObject({ code: "IMAGE_UNAVAILABLE" })

    expect(removed).toEqual([[...snapshot.images.map((image) => image.storagePath)].reverse()])
  })

  it("runs no more than three image transfers concurrently", async () => {
    let active = 0
    let maximum = 0
    const result = await prepareAdvertisingImages(snapshotWithImages(7), {
      downloadSource: async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { bytes: imageBytes, contentType: "image/png" }
      },
      downloadTarget: async () => null,
      uploadTarget: async () => {},
      removeTarget: async () => {},
    })

    expect(result.snapshot.images).toHaveLength(7)
    expect(maximum).toBe(3)
  })
})

describe("advertising Storage REST adapters", () => {
  it("encodes path segments and uses private server credentials with no upsert", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init })
      if (init.method === "POST") return new Response(null, { status: 200 })
      return new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      })
    }
    const deps = createAdvertisingStorageDependencies({
      sourceUrl: "https://abcdefghijklmnopqrst.supabase.co",
      sourceSecretKey: "sb_secret_source",
      targetUrl: "https://bcdefghijklmnopqrstu.supabase.co",
      targetSecretKey: "sb_secret_target",
      fetchImpl,
    })

    await deps.downloadSource("suggestions/folder name/image.png")
    await deps.uploadTarget("suggestions/folder name/image.png", imageBytes, "image/png")

    expect(requests[0].url).toContain("suggestions/folder%20name/image.png")
    expect(new Headers(requests[0].init.headers).get("authorization")).toBe(
      "Bearer sb_secret_source",
    )
    expect(new Headers(requests[1].init.headers).get("x-upsert")).toBe("false")
    expect(new Headers(requests[1].init.headers).get("authorization")).toBe(
      "Bearer sb_secret_target",
    )
  })
})
