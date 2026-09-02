import { describe, expect, it } from "vitest"

import {
  digestAdvertisingSnapshot,
  parseAdvertisingSnapshot,
  parseHydratedAdvertisingSnapshot,
} from "../../supabase/functions/_shared/advertising-sync-model"

const PROJECT_ID = "51000000-0000-4000-8000-000000000001"
const ITEM_ID = "52000000-0000-4000-8000-000000000001"
const IMAGE_ID = "53000000-0000-4000-8000-000000000001"

function validSnapshot() {
  return {
    version: 1,
    capturedAt: "2026-09-02T01:02:03.000Z",
    project: {
      id: PROJECT_ID,
      name: "广告系统",
      slug: "advertising-system",
      projectUrl: "https://ads.example.com",
      sortOrder: 0,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
    items: [
      {
        id: ITEM_ID,
        projectId: PROJECT_ID,
        title: "数据展示",
        description: "展示广告数据",
        status: "approved",
        sortOrder: 0,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        voteBaseline: "18",
      },
    ],
    histories: [
      {
        sourceOrder: "1",
        roadmapItemId: ITEM_ID,
        fromStatus: null,
        toStatus: "approved",
        changedAt: "2026-08-25T00:00:00.000Z",
      },
    ],
    images: [
      {
        id: IMAGE_ID,
        roadmapItemId: ITEM_ID,
        storagePath: `suggestions/${ITEM_ID}/${IMAGE_ID}.png`,
        mimeType: "image/png",
        sizeBytes: 33,
        width: 2,
        height: 2,
        createdAt: "2026-08-25T00:01:00.000Z",
      },
    ],
  }
}

type SnapshotFixture = ReturnType<typeof validSnapshot> & Record<string, unknown>

describe("advertising snapshot validation", () => {
  it("accepts the fixed one-project snapshot and returns an immutable copy", () => {
    const input = validSnapshot()
    const parsed = parseAdvertisingSnapshot(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.project.slug).toBe("advertising-system")
  })

  it.each([
    ["wrong slug", (value: SnapshotFixture) => (value.project.slug = "other")],
    ["unknown item project", (value: SnapshotFixture) => (value.items[0].projectId = IMAGE_ID)],
    ["unknown history item", (value: SnapshotFixture) => (value.histories[0].roadmapItemId = IMAGE_ID)],
    ["unknown image item", (value: SnapshotFixture) => (value.images[0].roadmapItemId = IMAGE_ID)],
    ["invalid vote baseline", (value: SnapshotFixture) => (value.items[0].voteBaseline = "1.5")],
    ["unsafe vote baseline", (value: SnapshotFixture) => (value.items[0].voteBaseline = "9223372036854775808")],
    ["oversized image", (value: SnapshotFixture) => (value.images[0].sizeBytes = 5_000_000)],
    ["wrong image mime", (value: SnapshotFixture) => (value.images[0].mimeType = "image/webp")],
    ["wrong image path", (value: SnapshotFixture) => (value.images[0].storagePath = "../escape.png")],
    ["invalid status", (value: SnapshotFixture) => (value.items[0].status = "archived")],
    ["extra top-level key", (value: SnapshotFixture) => (value.token = "forbidden")],
    [
      "nested sensitive key",
      (value: SnapshotFixture) =>
        ((value.items[0] as unknown as Record<string, unknown>).ip_hash = "x"),
    ],
  ])("rejects %s", (_name, mutate) => {
    const value = validSnapshot()
    mutate(value)
    expect(() => parseAdvertisingSnapshot(value)).toThrow("广告系统快照无效")
  })

  it("rejects duplicate item, history order, image identity, path, and item-image relation", () => {
    const value = validSnapshot()
    value.items.push({ ...value.items[0] })
    value.histories.push({ ...value.histories[0] })
    value.images.push({ ...value.images[0] })

    expect(() => parseAdvertisingSnapshot(value)).toThrow("广告系统快照无效")
  })

  it("enforces collection limits and total logical image bytes", () => {
    const itemTemplate = validSnapshot().items[0]
    const tooManyItems = validSnapshot()
    tooManyItems.items = Array.from({ length: 5_001 }, (_, index) => ({
      ...itemTemplate,
      id: `52000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }))
    tooManyItems.histories = []
    tooManyItems.images = []
    expect(() => parseAdvertisingSnapshot(tooManyItems)).toThrow("广告系统快照无效")

    const tooManyBytes = validSnapshot()
    tooManyBytes.items = []
    tooManyBytes.histories = []
    tooManyBytes.images = []
    for (let index = 1; index <= 201; index += 1) {
      const suffix = String(index).padStart(12, "0")
      const itemId = `52000000-0000-4000-8000-${suffix}`
      const imageId = `53000000-0000-4000-8000-${suffix}`
      tooManyBytes.items.push({ ...itemTemplate, id: itemId })
      tooManyBytes.images.push({
        ...validSnapshot().images[0],
        id: imageId,
        roadmapItemId: itemId,
        storagePath: `suggestions/${itemId}/${imageId}.png`,
        sizeBytes: 4_999_999,
      })
    }
    expect(() => parseAdvertisingSnapshot(tooManyBytes)).toThrow(
      "图片逻辑总量超过 1GB",
    )
  })

  it("requires SHA-256 only after image hydration", () => {
    const source = validSnapshot()
    expect(() => parseHydratedAdvertisingSnapshot(source)).toThrow(
      "广告系统快照无效",
    )

    const hydrated = {
      ...source,
      images: source.images.map((image) => ({ ...image, sha256: "a".repeat(64) })),
    }
    expect(parseHydratedAdvertisingSnapshot(hydrated)).toEqual(hydrated)
  })
})

describe("advertising snapshot digest", () => {
  it("is stable across object key insertion order", async () => {
    const original = {
      ...validSnapshot(),
      images: validSnapshot().images.map((image) => ({
        ...image,
        sha256: "a".repeat(64),
      })),
    }
    const topLevelReordered = {
      images: original.images,
      histories: original.histories,
      items: original.items,
      project: original.project,
      capturedAt: original.capturedAt,
      version: original.version,
    }

    await expect(digestAdvertisingSnapshot(original)).resolves.toBe(
      await digestAdvertisingSnapshot(topLevelReordered),
    )
  })

  it("changes when a mirrored business field changes", async () => {
    const original = {
      ...validSnapshot(),
      images: validSnapshot().images.map((image) => ({
        ...image,
        sha256: "a".repeat(64),
      })),
    }
    const changed = structuredClone(original)
    changed.items[0].voteBaseline = "19"

    expect(await digestAdvertisingSnapshot(changed)).not.toBe(
      await digestAdvertisingSnapshot(original),
    )
  })
})
