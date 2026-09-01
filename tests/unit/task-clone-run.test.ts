import { describe, expect, it } from "vitest"

import {
  copyTarget,
  deployTarget,
  domainTarget,
  validateTargetReadyAudit,
} from "../../scripts/task-clone/run.mjs"

describe("task clone orchestration", () => {
  it("validates target readiness without reading a new source snapshot", () => {
    const report = validateTargetReadyAudit(
      {
        projects: [{ id: "project" }],
        items: [{ id: "item", voteBaseline: "12", voteCount: "12" }],
        images: [{ sizeBytes: 4096 }],
        usedBytes: 4096,
        operationalCounts: {
          votes: 0,
          suggestionRateLimits: 0,
          suggestionImageRateLimits: 0,
        },
        bucket: {
          public: false,
          fileSizeLimit: 5_000_000,
          allowedMimeTypes: ["image/jpeg", "image/png"],
        },
        authUsers: [],
      },
      { expectedAuthEmails: [] },
    )

    expect(report).toEqual({ ok: true, differences: [] })
  })

  it("retries a stale source snapshot before importing once", async () => {
    const events: string[] = []
    let attempts = 0
    const result = await copyTarget({
      captureSnapshot: async () => {
        events.push("snapshot")
        return { attempt: ++attempts }
      },
      hydrateHashes: async (snapshot: { attempt: number }) => {
        events.push(`hydrate-${snapshot.attempt}`)
        if (snapshot.attempt < 3) {
          throw Object.assign(new Error("stale"), { code: "SOURCE_SNAPSHOT_STALE" })
        }
        return snapshot
      },
      assertFreshTarget: async () => events.push("fresh"),
      copyObjects: async () => {
        events.push("objects")
        return { uploadedPaths: [] }
      },
      importData: async () => events.push("import"),
      audit: async () => ({ ok: true, differences: [] }),
      cleanupObjects: async () => events.push("cleanup"),
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual([
      "snapshot",
      "hydrate-1",
      "snapshot",
      "hydrate-2",
      "snapshot",
      "hydrate-3",
      "fresh",
      "objects",
      "import",
    ])
  })

  it("cleans copied objects when import reconciliation fails", async () => {
    const events: string[] = []

    await expect(
      copyTarget({
        captureSnapshot: async () => ({}),
        hydrateHashes: async (snapshot: unknown) => snapshot,
        assertFreshTarget: async () => {},
        copyObjects: async () => ({ uploadedPaths: ["one.jpg"] }),
        importData: async () => events.push("import"),
        audit: async () => ({ ok: false, differences: ["票数"] }),
        cleanupImportedData: async () => events.push("cleanup-data"),
        cleanupObjects: async () => events.push("cleanup"),
      }),
    ).rejects.toThrow("目标数据核对失败")

    expect(events).toEqual(["import", "cleanup-data", "cleanup"])
  })

  it("takes a new snapshot when source bytes change during object copy", async () => {
    const events: string[] = []
    let attempts = 0

    const result = await copyTarget({
      captureSnapshot: async () => ({ attempt: ++attempts }),
      hydrateHashes: async (snapshot: { attempt: number }) => snapshot,
      assertFreshTarget: async () => events.push("fresh"),
      copyObjects: async (snapshot: { attempt: number }) => {
        events.push(`copy-${snapshot.attempt}`)
        if (snapshot.attempt === 1) {
          throw Object.assign(new Error("stale"), { code: "SOURCE_SNAPSHOT_STALE" })
        }
        return { uploadedPaths: [] }
      },
      importData: async () => events.push("import"),
      audit: async () => ({ ok: true, differences: [] }),
      cleanupObjects: async () => events.push("cleanup"),
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual(["fresh", "copy-1", "cleanup", "fresh", "copy-2", "import"])
  })

  it("deploys nothing before a successful copy assertion", async () => {
    const events: string[] = []

    await expect(
      deployTarget({
        assertCopyReconciled: async () => {
          events.push("assert")
          throw new Error("copy missing")
        },
        configureAuth: async () => events.push("auth"),
        deployEdge: async () => events.push("edge"),
        deployPages: async () => events.push("pages"),
        audit: async () => ({ ok: true }),
      }),
    ).rejects.toThrow("copy missing")

    expect(events).toEqual(["assert"])
  })

  it("binds no domain before the stable Pages smoke passes", async () => {
    const events: string[] = []

    await expect(
      domainTarget({
        assertStableSmoke: async () => {
          events.push("smoke")
          throw new Error("smoke failed")
        },
        preflightDomain: async () => events.push("preflight"),
        bindDomain: async () => events.push("bind"),
      }),
    ).rejects.toThrow("smoke failed")

    expect(events).toEqual(["smoke"])
  })
})
