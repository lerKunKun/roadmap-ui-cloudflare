import { describe, expect, it } from "vitest"

import {
  assertAllowedSmokeUrl,
  assertSupabaseRequestHost,
  assertSecurityHeaders,
  operationalSnapshotSql,
  restoreOperationalSql,
  runSmokeWorkflow,
} from "../../scripts/task-clone/smoke.mjs"

describe("task clone production smoke", () => {
  it.each([
    "https://task-roadmap-ui.pages.dev",
    "https://task.telljax.com",
  ])("accepts the target host %s", (url) => {
    expect(assertAllowedSmokeUrl(url).href).toBe(`${url}/`)
  })

  it.each(["https://telljax.com", "http://task.telljax.com", "https://example.com"])(
    "refuses the non-target URL %s",
    (url) => {
      expect(() => assertAllowedSmokeUrl(url)).toThrow("冒烟地址不是 Task Roadmap")
    },
  )

  it("accepts only browser Supabase requests to the target project", () => {
    expect(() =>
      assertSupabaseRequestHost(
        "https://bcdefghijklmnopqrstu.supabase.co/rest/v1/projects",
        "bcdefghijklmnopqrstu",
      ),
    ).not.toThrow()
    expect(() =>
      assertSupabaseRequestHost(
        "https://abcdefghijklmnopqrst.supabase.co/rest/v1/projects",
        "bcdefghijklmnopqrstu",
      ),
    ).toThrow("浏览器请求了非目标 Supabase")
  })

  it("restores only the smoke runner quota hashes and leaves votes untouched", () => {
    const hashes = {
      suggestionHash: "a".repeat(64),
      imageHash: "b".repeat(64),
    }
    const snapshotSql = operationalSnapshotSql(hashes)
    const restoreSql = restoreOperationalSql({
      ...hashes,
      suggestionRateLimits: [],
      suggestionImageRateLimits: [],
      operationalCounts: {
        votes: 0,
        suggestionRateLimits: 0,
        suggestionImageRateLimits: 0,
      },
    })

    expect(snapshotSql).toContain(`where ip_hash = '${hashes.suggestionHash}'`)
    expect(restoreSql).toContain(`where ip_hash = '${hashes.imageHash}'`)
    expect(restoreSql).not.toContain("delete from public.votes")
    expect(() =>
      operationalSnapshotSql({ ...hashes, suggestionHash: "unsafe'" }),
    ).toThrow("运行态哈希无效")
  })

  it("rejects a present but weakened security policy", () => {
    const headers = new Headers({
      "content-security-policy": "default-src *",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    })
    expect(() => assertSecurityHeaders(headers)).toThrow(
      "content-security-policy",
    )
  })

  it("runs target checks and unconditional cleanup without changing source counters", async () => {
    const events: string[] = []
    const source = { projects: 1, items: 10, voteTotal: "35" }

    const result = await runSmokeWorkflow({
      baseUrl: "https://task-roadmap-ui.pages.dev",
      readSourceCounters: async () => ({ ...source }),
      createFixtureIdentity: () => ({ prefix: "safe" }),
      captureOperationalState: async () => ({ before: true }),
      openBrowser: async () => ({ id: "browser" }),
      submitFixtures: async () => {
        events.push("submit")
        return { itemIds: ["one", "two"] }
      },
      verifyAdminAndApprove: async () => events.push("admin"),
      verifyMediaCache: async () => events.push("cache"),
      verifyDuplicateVote: async () => events.push("vote"),
      cleanupFixtures: async (_browser: unknown, _fixtures: unknown, identity: unknown) => {
        expect(identity).toEqual({ prefix: "safe" })
        events.push("cleanup")
      },
      restoreOperationalState: async (snapshot: unknown) => {
        expect(snapshot).toEqual({ before: true })
        events.push("cleanup-rate")
      },
      verifyTargetRestored: async () => events.push("verify-restored"),
      closeBrowser: async () => events.push("close"),
    })

    expect(result.ok).toBe(true)
    expect(events).toEqual([
      "submit",
      "admin",
      "cache",
      "vote",
      "cleanup",
      "cleanup-rate",
      "verify-restored",
      "close",
    ])
  })

  it("still cleans target fixtures and closes the browser after a failure", async () => {
    const events: string[] = []

    await expect(
      runSmokeWorkflow({
        baseUrl: "https://task.telljax.com",
        readSourceCounters: async () => ({ items: 10 }),
        createFixtureIdentity: () => ({ prefix: "safe" }),
        captureOperationalState: async () => ({ before: true }),
        openBrowser: async () => ({ id: "browser" }),
        submitFixtures: async () => ({ itemIds: ["one"] }),
        verifyAdminAndApprove: async () => {
          throw new Error("approval failed")
        },
        verifyMediaCache: async () => {},
        verifyDuplicateVote: async () => {},
        cleanupFixtures: async () => events.push("cleanup"),
        restoreOperationalState: async () => events.push("cleanup-rate"),
        verifyTargetRestored: async () => events.push("verify-restored"),
        closeBrowser: async () => events.push("close"),
      }),
    ).rejects.toThrow("approval failed")

    expect(events).toEqual(["cleanup", "cleanup-rate", "verify-restored", "close"])
  })

  it("discovers fixtures by the preallocated prefix and checks source after failure", async () => {
    const events: string[] = []
    let sourceReads = 0

    await expect(
      runSmokeWorkflow({
        baseUrl: "https://task-roadmap-ui.pages.dev",
        readSourceCounters: async () => {
          sourceReads += 1
          return { items: 10 }
        },
        createFixtureIdentity: () => ({ prefix: "allocated-before-browser" }),
        captureOperationalState: async () => ({ exact: true }),
        openBrowser: async () => ({ id: "browser" }),
        submitFixtures: async () => {
          throw new Error("second submit failed")
        },
        verifyAdminAndApprove: async () => {},
        verifyMediaCache: async () => {},
        verifyDuplicateVote: async () => {},
        cleanupFixtures: async (
          _browser: unknown,
          fixtures: unknown,
          identity: { prefix: string },
        ) => {
          expect(fixtures).toBeUndefined()
          expect(identity.prefix).toBe("allocated-before-browser")
          events.push("discover-cleanup")
        },
        restoreOperationalState: async () => events.push("restore-exact"),
        verifyTargetRestored: async () => events.push("audit"),
        closeBrowser: async () => events.push("close"),
      }),
    ).rejects.toThrow("second submit failed")

    expect(sourceReads).toBe(2)
    expect(events).toEqual(["discover-cleanup", "restore-exact", "audit", "close"])
  })
})
