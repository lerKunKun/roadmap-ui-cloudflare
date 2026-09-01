import { describe, expect, it } from "vitest"

import {
  parseCloneManifest,
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
        sha256: null,
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
