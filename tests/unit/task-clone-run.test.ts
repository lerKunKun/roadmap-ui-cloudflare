import { describe, expect, it } from "vitest"

import {
  copyTarget,
  deployTarget,
  domainTarget,
  validateStageReceipts,
  validateTargetReadyAudit,
} from "../../scripts/task-clone/run.mjs"

describe("task clone orchestration", () => {
  it("validates target readiness without reading a new source snapshot", () => {
    const report = validateTargetReadyAudit(
      {
        projects: [{ id: "project" }],
        items: [{ id: "item", voteBaseline: "12", voteCount: "12" }],
        images: [
          {
            storagePath: "suggestions/a/b.png",
            sizeBytes: 4096,
            mimeType: "image/png",
          },
        ],
        storageObjects: [
          {
            name: "suggestions/a/b.png",
            sizeBytes: 4096,
            mimeType: "image/png",
          },
        ],
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

  it.each([
    ["sizeBytes", 999],
    ["mimeType", "text/plain"],
  ])("rejects Storage object metadata drift in %s", (field, value) => {
    const report = validateTargetReadyAudit(
      {
        projects: [{ id: "project" }],
        items: [{ id: "item", voteBaseline: "12", voteCount: "12" }],
        images: [
          {
            storagePath: "suggestions/a/b.png",
            sizeBytes: 4096,
            mimeType: "image/png",
          },
        ],
        storageObjects: [
          {
            name: "suggestions/a/b.png",
            sizeBytes: field === "sizeBytes" ? value : 4096,
            mimeType: field === "mimeType" ? value : "image/png",
          },
        ],
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

    expect(report.ok).toBe(false)
    expect(report.differences).toContain("图片对象元数据不一致")
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

  it("recognizes an import committed before a transport failure and keeps its objects", async () => {
    const events: string[] = []
    const result = await copyTarget({
      captureSnapshot: async () => ({ source: true }),
      hydrateHashes: async (snapshot: unknown) => snapshot,
      assertFreshTarget: async () => {},
      copyObjects: async () => ({ uploadedPaths: ["one.jpg"] }),
      prepareImport: async () => ({ manifestDigest: "a".repeat(64) }),
      importData: async () => {
        events.push("import")
        throw new Error("connection closed after commit")
      },
      confirmImport: async () => {
        events.push("confirm")
        return "committed"
      },
      audit: async () => ({ ok: true, differences: [] }),
      persistCopyReceipt: async () => events.push("receipt"),
      cleanupImportedData: async () => events.push("cleanup-data"),
      cleanupObjects: async () => events.push("cleanup-objects"),
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual(["import", "confirm", "receipt"])
  })

  it("cleans uploaded objects when receipt preparation fails", async () => {
    const events: string[] = []
    await expect(
      copyTarget({
        captureSnapshot: async () => ({}),
        hydrateHashes: async (snapshot: unknown) => snapshot,
        assertFreshTarget: async () => {},
        copyObjects: async () => ({ uploadedPaths: ["one.jpg"] }),
        prepareImport: async () => {
          throw new Error("git unavailable")
        },
        importData: async () => events.push("import"),
        audit: async () => ({ ok: true, differences: [] }),
        cleanupObjects: async () => events.push("cleanup-objects"),
      }),
    ).rejects.toThrow("git unavailable")
    expect(events).toEqual(["cleanup-objects"])
  })

  it("preserves an ambiguous target and writes a retry receipt", async () => {
    const events: string[] = []
    await expect(
      copyTarget({
        captureSnapshot: async () => ({}),
        hydrateHashes: async (snapshot: unknown) => snapshot,
        assertFreshTarget: async () => {},
        copyObjects: async () => ({ uploadedPaths: ["one.jpg"] }),
        prepareImport: async () => ({ manifestDigest: "a".repeat(64) }),
        importData: async () => {
          throw new Error("transport lost")
        },
        confirmImport: async () => "unknown",
        persistAmbiguityReceipt: async () => events.push("ambiguity"),
        audit: async () => ({ ok: true, differences: [] }),
        cleanupImportedData: async () => events.push("cleanup-data"),
        cleanupObjects: async () => events.push("cleanup-objects"),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_COMMIT_UNKNOWN" })
    expect(events).toEqual(["ambiguity"])
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

  it("requires Pages smoke for domain and final-domain smoke for ready status", () => {
    const common = {
      sourceRef: "abcdefghijklmnopqrst",
      targetRef: "bcdefghijklmnopqrstu",
      commit: "f".repeat(40),
      copyReceipt: {
        sourceProjectRef: "abcdefghijklmnopqrst",
        targetProjectRef: "bcdefghijklmnopqrstu",
        appCommit: "f".repeat(40),
        manifestDigest: "a".repeat(64),
      },
      smokeReceipt: {
        targetProjectRef: "bcdefghijklmnopqrstu",
        appCommit: "f".repeat(40),
        copyDigest: "a".repeat(64),
        baseUrl: "https://task-roadmap-ui.pages.dev/",
      },
    }

    expect(() => validateStageReceipts("domain", common)).not.toThrow()
    expect(() => validateStageReceipts("status", common)).toThrow(
      "最终域名冒烟回执",
    )
    expect(() =>
      validateStageReceipts("domain", {
        ...common,
        copyReceipt: {
          ...common.copyReceipt,
          sourceProjectRef: "wrongsourceprojectxx",
        },
      }),
    ).toThrow("复制回执")
  })
})
