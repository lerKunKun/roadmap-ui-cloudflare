import { describe, expect, it } from "vitest"

import {
  runAdvertisingSync,
  type AdvertisingSyncDependencies,
} from "../../supabase/functions/_shared/advertising-sync-runner"

const PROJECT_ID = "a1000000-0000-4000-8000-000000000001"

function snapshot() {
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
    items: [],
    histories: [],
    images: [],
  }
}

function dependencies(events: string[] = []): AdvertisingSyncDependencies {
  let time = 1_000
  return {
    claim: async () => {
      events.push("claim")
      return true
    },
    fetchSnapshot: async () => {
      events.push("fetch")
      return snapshot()
    },
    prepareImages: async (value: unknown) => {
      events.push("images")
      return { snapshot: value, uploadedPaths: [] }
    },
    digest: async () => {
      events.push("digest")
      return "a".repeat(64)
    },
    apply: async () => {
      events.push("apply")
      return { applied: true, cleanupPaths: [] }
    },
    confirmApply: async () => "not_committed" as const,
    fail: async () => {
      events.push("fail")
    },
    cleanupQueuedObjects: async () => {
      events.push("cleanup")
      return { attempted: 0, failed: 0 }
    },
    compensate: async () => {
      events.push("compensate")
    },
    now: () => {
      time += 25
      return time
    },
    randomUuid: () => "b1000000-0000-4000-8000-000000000001",
    logger: () => {},
  }
}

describe("advertising sync runner", () => {
  it("claims, validates, prepares, applies, and cleans in strict order", async () => {
    const events: string[] = []
    const result = await runAdvertisingSync(dependencies(events))

    expect(events).toEqual([
      "claim",
      "fetch",
      "images",
      "digest",
      "apply",
      "cleanup",
    ])
    expect(result).toMatchObject({
      ok: true,
      runId: "b1000000-0000-4000-8000-000000000001",
      digest: "a".repeat(64),
      counts: { items: 0, histories: 0, images: 0 },
      cleanup: { attempted: 0, failed: 0 },
    })
  })

  it("returns busy before reading the source when the lease is held", async () => {
    const events: string[] = []
    const deps = dependencies(events)
    deps.claim = async () => false

    await expect(runAdvertisingSync(deps)).rejects.toMatchObject({
      code: "SYNC_BUSY",
    })
    expect(events).toEqual([])
  })

  it("retries one source transport failure and no more", async () => {
    const events: string[] = []
    const deps = dependencies(events)
    let attempts = 0
    deps.fetchSnapshot = async () => {
      events.push("fetch")
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error("upstream body"), {
          code: "SOURCE_UNAVAILABLE",
        })
      }
      return snapshot()
    }

    await expect(runAdvertisingSync(deps)).resolves.toMatchObject({ ok: true })
    expect(events.filter((event) => event === "fetch")).toHaveLength(2)

    attempts = 0
    deps.fetchSnapshot = async () => {
      attempts += 1
      throw Object.assign(new Error("still down"), {
        code: "SOURCE_UNAVAILABLE",
      })
    }
    await expect(runAdvertisingSync(deps)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    })
    expect(attempts).toBe(2)
  })

  it("does not retry or copy images for an invalid snapshot", async () => {
    const events: string[] = []
    const deps = dependencies(events)
    deps.fetchSnapshot = async () => ({ ...snapshot(), project: null })

    await expect(runAdvertisingSync(deps)).rejects.toMatchObject({
      code: "SNAPSHOT_INVALID",
    })
    expect(events).toEqual(["claim", "fail"])
  })

  it("compensates uploaded images and records failure when apply is not committed", async () => {
    const events: string[] = []
    const deps = dependencies(events)
    deps.prepareImages = async (value: unknown) => ({
      snapshot: value,
      uploadedPaths: ["suggestions/new/image.png"],
    })
    deps.apply = async () => {
      events.push("apply")
      throw Object.assign(new Error("connection lost"), {
        code: "TARGET_APPLY_FAILED",
      })
    }
    deps.confirmApply = async () => {
      events.push("confirm")
      return "not_committed"
    }
    deps.compensate = async (paths: string[]) => {
      events.push(`compensate:${paths.join(",")}`)
    }

    await expect(runAdvertisingSync(deps)).rejects.toMatchObject({
      code: "TARGET_APPLY_FAILED",
    })
    expect(events).toContain("confirm")
    expect(events).toContain("compensate:suggestions/new/image.png")
    expect(events.at(-1)).toBe("fail")
  })

  it("keeps uploaded images when status proves an ambiguous apply committed", async () => {
    const events: string[] = []
    const deps = dependencies(events)
    deps.prepareImages = async (value: unknown) => ({
      snapshot: value,
      uploadedPaths: ["suggestions/new/image.png"],
    })
    deps.apply = async () => {
      events.push("apply")
      throw new Error("transport closed after commit")
    }
    deps.confirmApply = async () => {
      events.push("confirm")
      return "committed"
    }

    await expect(runAdvertisingSync(deps)).resolves.toMatchObject({ ok: true })
    expect(events).not.toContain("compensate")
    expect(events).not.toContain("fail")
    expect(events).toContain("cleanup")
  })

  it("reports cleanup debt without failing a committed database sync", async () => {
    const deps = dependencies()
    deps.cleanupQueuedObjects = async () => ({ attempted: 2, failed: 1 })

    await expect(runAdvertisingSync(deps)).resolves.toMatchObject({
      ok: true,
      cleanup: { attempted: 2, failed: 1 },
    })
  })

  it("logs only run metadata and safe codes", async () => {
    const logs: unknown[] = []
    const deps = dependencies()
    deps.logger = (entry: unknown) => {
      logs.push(entry)
    }
    deps.fetchSnapshot = async () => {
      throw Object.assign(
        new Error("customer title and sb_secret_should_not_log"),
        { code: "SOURCE_UNAVAILABLE" },
      )
    }

    await expect(runAdvertisingSync(deps)).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    })
    const serialized = JSON.stringify(logs)
    expect(serialized).toContain("SOURCE_UNAVAILABLE")
    expect(serialized).not.toContain("customer title")
    expect(serialized).not.toContain("sb_secret")
  })
})
