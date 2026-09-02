import { describe, expect, it } from "vitest"

import {
  acceptAdvertisingSync,
  assertAdvertisingEvidenceEqual,
  buildCleanupAcceptanceSql,
  buildCreateSentinelSql,
  buildSourceEvidenceSql,
} from "../../scripts/task-clone/advertising-sync-acceptance.mjs"

const sourceRef = "abcdefghijklmnopqrst"
const targetRef = "bcdefghijklmnopqrstu"
const appCommit = "c".repeat(40)
const snapshotDigest = "d".repeat(64)

function sourceEvidence() {
  return {
    contentDigest: "a".repeat(64),
    counters: { projects: 4, items: 3, votes: 2 },
    snapshot: {
      version: 1,
      capturedAt: "2026-09-02T00:00:00.000Z",
      project: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "广告系统",
        slug: "advertising-system",
        projectUrl: "https://example.com",
        sortOrder: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
      items: [],
      histories: [],
      images: [],
    },
  }
}

function targetEvidence() {
  const snapshot = structuredClone(sourceEvidence().snapshot)
  delete (snapshot as Partial<typeof snapshot>).capturedAt
  return snapshot
}

function createAdapters(failAt?: string) {
  const events: string[] = []
  let sourceReads = 0
  const fail = (stage: string) => {
    events.push(stage)
    if (failAt === stage) throw new Error(`failed:${stage}`)
  }
  const adapters = {
    sourceProjectRef: sourceRef,
    targetProjectRef: targetRef,
    appCommit,
    now: () => new Date("2026-09-02T01:00:00.000Z"),
    clearReceipt: async () => fail("clear-receipt"),
    readSourceEvidence: async () => {
      fail(`source-${++sourceReads}`)
      return sourceEvidence()
    },
    allocateSentinelIdentity: () => {
      fail("allocate-sentinel")
      return { projectId: "sentinel-project", itemId: "sentinel-item" }
    },
    createSentinel: async () => {
      fail("create-sentinel")
    },
    readSentinel: async () => {
      fail("read-sentinel")
      return { project: { id: "sentinel-project" }, votes: [{ id: "vote" }] }
    },
    trigger: async () => {
      const triggerNumber =
        events.filter((event) => event.startsWith("trigger-")).length + 1
      fail(`trigger-${triggerNumber}`)
      return { ok: true }
    },
    readTargetAdvertising: async () => {
      fail("read-target")
      return targetEvidence()
    },
    assertImageHashesEqual: async () => fail("images"),
    allocateLocalAdvertisingIdentity: () => {
      fail("allocate-local-ad")
      return { itemId: "local-ad-item", voteId: "local-ad-vote" }
    },
    createLocalAdvertisingMutation: async () => {
      fail("create-local-ad")
    },
    localAdvertisingMutationExists: async () => {
      fail("local-ad-exists")
      return false
    },
    readStatus: async () => {
      fail("status")
      return {
        lastSnapshotDigest: snapshotDigest,
        cleanupCount: 0,
        cronActive: false,
        busy: false,
        lastErrorCode: null,
      }
    },
    cleanupFixtures: async () => fail("cleanup"),
    writeReceipt: async () => fail("write-receipt"),
  }
  return { adapters, events }
}

describe("advertising sync acceptance orchestration", () => {
  it("proves strict mirroring, sentinel isolation, local-edit deletion and safe state", async () => {
    const { adapters, events } = createAdapters()
    const receipt = await acceptAdvertisingSync(adapters)

    expect(receipt).toMatchObject({
      version: 1,
      sourceProjectRef: sourceRef,
      targetProjectRef: targetRef,
      appCommit,
      snapshotDigest,
      counts: { projects: 1, items: 0, histories: 0, images: 0 },
      checks: {
        advertisingEqual: true,
        imageHashesEqual: true,
        sourceUnchanged: true,
        targetSentinelUnchanged: true,
        targetLocalAdvertisingRemoved: true,
        cleanupQueueEmpty: true,
        cronInactive: true,
      },
    })
    expect(events).toEqual([
      "clear-receipt",
      "source-1",
      "allocate-sentinel",
      "create-sentinel",
      "read-sentinel",
      "trigger-1",
      "source-2",
      "read-target",
      "images",
      "read-sentinel",
      "allocate-local-ad",
      "create-local-ad",
      "trigger-2",
      "local-ad-exists",
      "source-3",
      "read-target",
      "images",
      "read-sentinel",
      "status",
      "cleanup",
      "write-receipt",
    ])
  })

  it.each([
    "source-1",
    "allocate-sentinel",
    "create-sentinel",
    "read-sentinel",
    "trigger-1",
    "source-2",
    "read-target",
    "images",
    "allocate-local-ad",
    "create-local-ad",
    "trigger-2",
    "local-ad-exists",
    "source-3",
    "status",
  ])(
    "cleans generated fixtures and never writes a receipt after %s fails",
    async (stage) => {
      const { adapters, events } = createAdapters(stage)
      await expect(acceptAdvertisingSync(adapters)).rejects.toThrow(
        `failed:${stage}`
      )
      if (
        events.includes("allocate-sentinel") &&
        stage !== "allocate-sentinel"
      ) {
        expect(events).toContain("cleanup")
      }
      expect(events).not.toContain("write-receipt")
    }
  )

  it("does not write a receipt when cleanup itself fails", async () => {
    const { adapters, events } = createAdapters("cleanup")
    await expect(acceptAdvertisingSync(adapters)).rejects.toThrow(
      "failed:cleanup"
    )
    expect(events).not.toContain("write-receipt")
  })
})

describe("advertising evidence reconciliation", () => {
  it("compares every business field while ignoring capture time and history sequence ids", () => {
    const source = sourceEvidence().snapshot
    const target = targetEvidence()
    expect(() => assertAdvertisingEvidenceEqual(source, target)).not.toThrow()

    expect(() =>
      assertAdvertisingEvidenceEqual(source, {
        ...target,
        project: { ...target.project, projectUrl: "https://changed.example" },
      })
    ).toThrow("目标广告系统与源不一致")
  })
})

describe("advertising acceptance SQL safety", () => {
  const sentinel = {
    projectId: "10000000-0000-4000-8000-000000000001",
    itemId: "10000000-0000-4000-8000-000000000002",
    voteId: "10000000-0000-4000-8000-000000000003",
    slug: `sync-acceptance-${"1".repeat(32)}`,
  }

  it("binds fixture cleanup to exact generated UUIDs and the sentinel prefix", () => {
    const sql = buildCleanupAcceptanceSql({
      sentinel,
      localAdvertisingMutation: {
        itemId: "10000000-0000-4000-8000-000000000004",
        voteId: "10000000-0000-4000-8000-000000000005",
      },
    })
    expect(sql).toContain(sentinel.projectId)
    expect(sql).toContain(sentinel.slug)
    expect(sql).not.toContain("where slug = 'advertising-system'")

    const withoutLocalMutation = buildCleanupAcceptanceSql({
      sentinel,
      localAdvertisingMutation: null,
    })
    expect(withoutLocalMutation).not.toContain(
      "00000000-0000-4000-8000-000000000000"
    )
  })

  it("rejects arbitrary fixture values before creating SQL", () => {
    expect(() =>
      buildCreateSentinelSql(
        { ...sentinel, slug: "advertising-system" },
        targetRef
      )
    ).toThrow("广告同步哨兵前缀无效")
    expect(() =>
      buildCreateSentinelSql(
        { ...sentinel, projectId: "' or true --" },
        targetRef
      )
    ).toThrow("哨兵项目 UUID 无效")
  })

  it("keeps source evidence collection a single read-only SELECT", () => {
    const sql = buildSourceEvidenceSql().trim()
    expect(sql).toMatch(/^select\b/i)
    expect(sql.slice(0, -1)).not.toContain(";")
    expect(sql).toContain("export_advertising_roadmap_snapshot()")
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i)
  })
})
