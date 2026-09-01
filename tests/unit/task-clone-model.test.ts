import { describe, expect, it } from "vitest"

import {
  parseCloneManifest,
  reconcileSnapshot,
  validateCloneManifest,
} from "../../scripts/task-clone/model.mjs"

function validManifest() {
  return {
    version: 1,
    capturedAt: "2026-09-01T06:00:00.000Z",
    sourceProjectRef: "abcdefghijklmnopqrst",
    projects: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        name: "广告系统",
        slug: "advertising-system",
        projectUrl: "https://ads.example.com",
        sortOrder: 0,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    ],
    items: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        title: "支持批量导入",
        description: "允许批量创建素材",
        status: "approved",
        sortOrder: 0,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        voteBaseline: "9007199254740993",
      },
    ],
    histories: [
      {
        sourceOrder: "1",
        roadmapItemId: "20000000-0000-4000-8000-000000000001",
        fromStatus: null,
        toStatus: "approved",
        changedAt: "2026-08-25T00:00:00.000Z",
      },
    ],
    images: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        roadmapItemId: "20000000-0000-4000-8000-000000000001",
        storagePath:
          "suggestions/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        width: 800,
        height: 600,
        createdAt: "2026-08-25T00:01:00.000Z",
        sha256: null as string | null,
      },
    ],
  }
}

describe("task clone manifest", () => {
  it("preserves bigint vote totals as strings", () => {
    const manifest = parseCloneManifest(validManifest())

    expect(manifest.items[0].voteBaseline).toBe("9007199254740993")
  })

  it("rejects a missing project relationship", () => {
    const manifest = validManifest()
    manifest.items[0].projectId = "10000000-0000-4000-8000-000000000099"

    expect(validateCloneManifest(manifest)).toContain(
      "条目 20000000-0000-4000-8000-000000000001 引用了不存在的项目",
    )
  })

  it("rejects duplicate image paths and invalid image metadata", () => {
    const manifest = validManifest()
    manifest.images.push({
      ...manifest.images[0],
      id: "30000000-0000-4000-8000-000000000002",
      sizeBytes: 5_000_000,
    })

    expect(validateCloneManifest(manifest)).toEqual(
      expect.arrayContaining([
        "图片路径重复：suggestions/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg",
        "图片 30000000-0000-4000-8000-000000000002 的字节数无效",
      ]),
    )
  })

  it.each([
    ["votes", []],
    ["ip_hash", "a".repeat(64)],
    ["suggestion_rate_limits", []],
    ["suggestion_image_rate_limits", []],
    ["auth", { users: [] }],
    ["password", "secret"],
    ["token", "secret"],
    ["salt", "secret"],
  ])("rejects forbidden manifest key %s", (key, value) => {
    const manifest = validManifest() as Record<string, unknown>
    manifest[key] = value

    expect(validateCloneManifest(manifest)).toContain(`复制清单包含禁止字段：${key}`)
  })

  it("rejects unsafe numeric and negative vote baselines", () => {
    const numeric = validManifest()
    numeric.items[0].voteBaseline = Number.MAX_SAFE_INTEGER + 1 as never
    const negative = validManifest()
    negative.items[0].voteBaseline = "-1"

    expect(validateCloneManifest(numeric)).toContain(
      "条目 20000000-0000-4000-8000-000000000001 的历史票数无效",
    )
    expect(validateCloneManifest(negative)).toContain(
      "条目 20000000-0000-4000-8000-000000000001 的历史票数无效",
    )
  })
})

describe("task clone reconciliation", () => {
  it("accepts an exact copy with empty operational state", () => {
    const manifest = validManifest()
    manifest.items[0].voteBaseline = "7"
    manifest.images[0].sha256 = "a".repeat(64)
    const audit = {
      projects: manifest.projects,
      items: manifest.items.map((item) => ({ ...item, voteCount: "7" })),
      histories: manifest.histories.map((history) => ({
        roadmapItemId: history.roadmapItemId,
        fromStatus: history.fromStatus,
        toStatus: history.toStatus,
        changedAt: history.changedAt,
      })),
      images: manifest.images.map((image) => ({
        id: image.id,
        roadmapItemId: image.roadmapItemId,
        storagePath: image.storagePath,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        width: image.width,
        height: image.height,
        createdAt: image.createdAt,
      })),
      objectHashes: {
        [manifest.images[0].storagePath]: "a".repeat(64),
      },
      operationalCounts: {
        votes: 0,
        suggestionRateLimits: 0,
        suggestionImageRateLimits: 0,
      },
      usedBytes: 1024,
      bucket: {
        public: false,
        fileSizeLimit: 5_000_000,
        allowedMimeTypes: ["image/jpeg", "image/png"],
      },
      authUsers: [],
    }

    expect(
      reconcileSnapshot(manifest, audit, { expectedAuthUsers: 0 }),
    ).toMatchObject({ ok: true, differences: [] })
  })

  it("reports vote, hash, usage, operational, and auth divergence", () => {
    const manifest = validManifest()
    manifest.items[0].voteBaseline = "7"
    manifest.images[0].sha256 = "a".repeat(64)
    const audit = {
      projects: manifest.projects,
      items: manifest.items.map((item) => ({ ...item, voteCount: "8" })),
      histories: manifest.histories.map((history) => ({
        roadmapItemId: history.roadmapItemId,
        fromStatus: history.fromStatus,
        toStatus: history.toStatus,
        changedAt: history.changedAt,
      })),
      images: manifest.images.map((image) => ({
        id: image.id,
        roadmapItemId: image.roadmapItemId,
        storagePath: image.storagePath,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        width: image.width,
        height: image.height,
        createdAt: image.createdAt,
      })),
      objectHashes: {
        [manifest.images[0].storagePath]: "b".repeat(64),
      },
      operationalCounts: {
        votes: 1,
        suggestionRateLimits: 0,
        suggestionImageRateLimits: 0,
      },
      usedBytes: 1000,
      bucket: {
        public: false,
        fileSizeLimit: 5_000_000,
        allowedMimeTypes: ["image/jpeg", "image/png"],
      },
      authUsers: [{ email: "unexpected@example.com" }],
    }

    const result = reconcileSnapshot(manifest, audit, { expectedAuthUsers: 0 })

    expect(result.ok).toBe(false)
    expect(result.differences).toEqual(
      expect.arrayContaining([
        "公开票数不一致",
        "图片对象哈希不一致",
        "图片逻辑用量不一致",
        "目标 votes 必须为空",
        "目标 Auth 用户不符合预期",
      ]),
    )
  })
})
