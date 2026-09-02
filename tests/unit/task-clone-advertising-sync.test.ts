import { describe, expect, it } from "vitest"

import {
  installAdvertisingSync,
  normalizeAdvertisingSyncStatus,
  setAdvertisingSyncCronActive,
  triggerAdvertisingSync,
} from "../../scripts/task-clone/advertising-sync.mjs"

describe("advertising sync status", () => {
  it("keeps only safe Cron and pg_net response metadata", () => {
    expect(
      normalizeAdvertisingSyncStatus({
        lastAttemptAt: "2026-09-02T01:17:00Z",
        cleanup_count: 0,
        cron: { active: true, schedule: "17 * * * *" },
        net: {
          requestId: "9223372036854775807",
          statusCode: 200,
          timedOut: false,
          hasError: false,
          receivedAt: "2026-09-02T01:17:01Z",
        },
      })
    ).toMatchObject({
      cronActive: true,
      cronSchedule: "17 * * * *",
      latestNet: {
        requestId: "9223372036854775807",
        statusCode: 200,
        hasError: false,
      },
    })
  })
})

describe("advertising sync installation orchestration", () => {
  it("installs source read API and target runtime with Cron inactive in strict order", async () => {
    const events: string[] = []
    const result = await installAdvertisingSync({
      assertIdentity: async () => events.push("identity"),
      applySourceMigration: async () => events.push("source-migration"),
      applyTargetMigrations: async () => events.push("target-migrations"),
      applyTargetInfrastructure: async () =>
        events.push("target-infrastructure"),
      setEdgeSecrets: async () => events.push("edge-secrets"),
      deployEdgeFunction: async () => events.push("edge-deploy"),
      configureVault: async () => events.push("vault"),
      configureCron: async (active: boolean) => events.push(`cron-${active}`),
      readStatus: async () => {
        events.push("status")
        return { installed: true, cronActive: false }
      },
    })

    expect(events).toEqual([
      "identity",
      "source-migration",
      "target-migrations",
      "target-infrastructure",
      "edge-secrets",
      "edge-deploy",
      "vault",
      "cron-false",
      "status",
    ])
    expect(result).toEqual({ installed: true, cronActive: false })
  })

  it("stops before target mutation when identity validation fails", async () => {
    const events: string[] = []
    await expect(
      installAdvertisingSync({
        assertIdentity: async () => {
          throw new Error("identity mismatch")
        },
        applySourceMigration: async () => events.push("source"),
        applyTargetMigrations: async () => events.push("target-migrations"),
        applyTargetInfrastructure: async () => events.push("target"),
        setEdgeSecrets: async () => events.push("secrets"),
        deployEdgeFunction: async () => events.push("deploy"),
        configureVault: async () => events.push("vault"),
        configureCron: async () => events.push("cron"),
        readStatus: async () => ({}),
      })
    ).rejects.toThrow("identity mismatch")
    expect(events).toEqual([])
  })
})

describe("advertising sync manual trigger", () => {
  it("posts only to the fixed target function with publishable and dedicated keys", async () => {
    const requests: Array<{ url: string; request: Request }> = []
    const result = await triggerAdvertisingSync({
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "bcdefghijklmnopqrstu",
      targetUrl: "https://bcdefghijklmnopqrstu.supabase.co",
      publishableKey: `sb_publishable_${"p".repeat(32)}`,
      cronSecret: "a".repeat(64),
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push({ url: request.url, request })
        return Response.json({ ok: true, digest: "a".repeat(12) })
      },
    })

    expect(result).toEqual({ ok: true, digest: "a".repeat(12) })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(
      "https://bcdefghijklmnopqrstu.supabase.co/functions/v1/sync-advertising"
    )
    expect(requests[0].request.headers.get("apikey")).toMatch(
      /^sb_publishable_/
    )
    expect(requests[0].request.headers.get("x-roadmap-sync-secret")).toBe(
      "a".repeat(64)
    )
  })

  it("rejects source/target reuse before an HTTP request", async () => {
    let requested = false
    await expect(
      triggerAdvertisingSync({
        sourceProjectRef: "abcdefghijklmnopqrst",
        targetProjectRef: "abcdefghijklmnopqrst",
        targetUrl: "https://abcdefghijklmnopqrst.supabase.co",
        publishableKey: `sb_publishable_${"p".repeat(32)}`,
        cronSecret: "a".repeat(64),
        fetchImpl: async () => {
          requested = true
          return Response.json({})
        },
      })
    ).rejects.toThrow("同步项目身份无效")
    expect(requested).toBe(false)
  })
})

describe("advertising sync Cron activation", () => {
  const successfulStatus = {
    lastSnapshotDigest: "d".repeat(64),
    cleanupCount: 0,
    cronActive: false,
  }
  const receipt = {
    version: 1,
    sourceProjectRef: "abcdefghijklmnopqrst",
    targetProjectRef: "bcdefghijklmnopqrstu",
    appCommit: "c".repeat(40),
    snapshotDigest: "d".repeat(64),
    startedAt: "2026-09-02T01:00:00.000Z",
    completedAt: "2026-09-02T01:01:00.000Z",
    counts: { projects: 1, items: 2, histories: 3, images: 1 },
    checks: {
      advertisingEqual: true,
      imageHashesEqual: true,
      sourceUnchanged: true,
      targetSentinelUnchanged: true,
      targetLocalAdvertisingRemoved: true,
      cleanupQueueEmpty: true,
      cronInactive: true,
    },
  }

  it("enables only after matching successful isolation acceptance", async () => {
    const activeValues: boolean[] = []
    await expect(
      setAdvertisingSyncCronActive({
        active: true,
        sourceProjectRef: receipt.sourceProjectRef,
        targetProjectRef: receipt.targetProjectRef,
        appCommit: receipt.appCommit,
        status: successfulStatus,
        acceptanceReceipt: receipt,
        configureCron: async (active: boolean) => activeValues.push(active),
      })
    ).resolves.toEqual({ active: true })
    expect(activeValues).toEqual([true])
  })

  it("rejects cleanup debt, missing success, or mismatched receipt", async () => {
    const configureCron = async () => {
      throw new Error("must not run")
    }
    await expect(
      setAdvertisingSyncCronActive({
        active: true,
        sourceProjectRef: receipt.sourceProjectRef,
        targetProjectRef: receipt.targetProjectRef,
        appCommit: receipt.appCommit,
        status: { ...successfulStatus, cleanupCount: 1 },
        acceptanceReceipt: receipt,
        configureCron,
      })
    ).rejects.toThrow("自动同步启用条件未满足")
    await expect(
      setAdvertisingSyncCronActive({
        active: true,
        sourceProjectRef: receipt.sourceProjectRef,
        targetProjectRef: receipt.targetProjectRef,
        appCommit: receipt.appCommit,
        status: successfulStatus,
        acceptanceReceipt: {
          ...receipt,
          checks: { ...receipt.checks, imageHashesEqual: false },
        },
        configureCron,
      })
    ).rejects.toThrow("自动同步启用条件未满足")
    await expect(
      setAdvertisingSyncCronActive({
        active: true,
        sourceProjectRef: receipt.sourceProjectRef,
        targetProjectRef: receipt.targetProjectRef,
        appCommit: receipt.appCommit,
        status: successfulStatus,
        acceptanceReceipt: { ...receipt, snapshotDigest: "e".repeat(64) },
        configureCron,
      })
    ).rejects.toThrow("自动同步启用条件未满足")
  })

  it("always allows an authenticated operator to disable Cron", async () => {
    const activeValues: boolean[] = []
    await expect(
      setAdvertisingSyncCronActive({
        active: false,
        configureCron: async (active: boolean) => activeValues.push(active),
      })
    ).resolves.toEqual({ active: false })
    expect(activeValues).toEqual([false])
  })
})
