import { describe, expect, it } from "vitest"

import {
  createAdvertisingSyncHandler,
  readAdvertisingSyncJsonResponse,
  readAdvertisingSyncRuntimeConfig,
} from "../../supabase/functions/sync-advertising/index"

const SOURCE_REF = "abcdefghijklmnopqrst"
const TARGET_REF = "bcdefghijklmnopqrstu"

describe("advertising sync PostgREST responses", () => {
  it("accepts a successful 204 response from a void RPC", async () => {
    await expect(
      readAdvertisingSyncJsonResponse(
        new Response(null, { status: 204 }),
        "TARGET_APPLY_FAILED"
      )
    ).resolves.toBeNull()
  })
})

function runtimeValues() {
  return {
    ADVERTISING_SYNC_CRON_SECRET: "a".repeat(64),
    SOURCE_SUPABASE_URL: `https://${SOURCE_REF}.supabase.co`,
    SOURCE_SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
    SOURCE_SUPABASE_PROJECT_REF: SOURCE_REF,
    TARGET_SUPABASE_PROJECT_REF: TARGET_REF,
    SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: `service-role-${"t".repeat(32)}`,
  }
}

describe("advertising sync runtime config", () => {
  it("accepts the exact independent source and target identities", () => {
    const values = runtimeValues()
    expect(
      readAdvertisingSyncRuntimeConfig(
        (name) => values[name as keyof typeof values]
      )
    ).toMatchObject({
      sourceProjectRef: SOURCE_REF,
      targetProjectRef: TARGET_REF,
    })
  })

  it.each([
    "ADVERTISING_SYNC_CRON_SECRET",
    "SOURCE_SUPABASE_URL",
    "SOURCE_SUPABASE_SECRET_KEY",
    "SOURCE_SUPABASE_PROJECT_REF",
    "TARGET_SUPABASE_PROJECT_REF",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("rejects missing runtime value %s", (missing) => {
    const values: Record<string, string | undefined> = runtimeValues()
    values[missing] = undefined
    expect(() =>
      readAdvertisingSyncRuntimeConfig((name) => values[name])
    ).toThrow("同步运行配置无效")
  })

  it("rejects source/target reuse and target URL mismatch", () => {
    const same = { ...runtimeValues(), TARGET_SUPABASE_PROJECT_REF: SOURCE_REF }
    expect(() =>
      readAdvertisingSyncRuntimeConfig(
        (name) => same[name as keyof typeof same]
      )
    ).toThrow("同步运行配置无效")

    const mismatch = { ...runtimeValues(), SUPABASE_URL: "https://example.com" }
    expect(() =>
      readAdvertisingSyncRuntimeConfig(
        (name) => mismatch[name as keyof typeof mismatch]
      )
    ).toThrow("同步运行配置无效")
  })
})

describe("advertising sync HTTP handler", () => {
  it("rejects an unauthenticated request before reading source or target config", async () => {
    const handler = createAdvertisingSyncHandler({
      getEnv: (name) =>
        name === "ADVERTISING_SYNC_CRON_SECRET" ? "a".repeat(64) : undefined,
      run: async () => ({ ok: true }),
    })

    const response = await handler(
      new Request("https://target.example/sync", { method: "POST" })
    )
    expect(response.status).toBe(401)
  })

  it("rejects missing or invalid dedicated secret before running sync", async () => {
    let runs = 0
    const handler = createAdvertisingSyncHandler({
      getEnv: (name) =>
        runtimeValues()[name as keyof ReturnType<typeof runtimeValues>],
      run: async () => {
        runs += 1
        return { ok: true }
      },
    })

    for (const provided of [null, "wrong"]) {
      const headers = new Headers()
      if (provided) headers.set("x-roadmap-sync-secret", provided)
      const response = await handler(
        new Request("https://target.example/sync", { method: "POST", headers })
      )
      expect(response.status).toBe(401)
    }
    expect(runs).toBe(0)
  })

  it("accepts POST with the dedicated secret and returns bounded metadata", async () => {
    const values = runtimeValues()
    const handler = createAdvertisingSyncHandler({
      getEnv: (name) => values[name as keyof typeof values],
      run: async () => ({
        ok: true,
        runId: "c1000000-0000-4000-8000-000000000001",
        digest: "a".repeat(64),
        counts: { items: 2, histories: 3, images: 1 },
        durationMs: 125,
        cleanup: { attempted: 0, failed: 0 },
      }),
    })
    const response = await handler(
      new Request("https://target.example/sync", {
        method: "POST",
        headers: {
          "x-roadmap-sync-secret": values.ADVERTISING_SYNC_CRON_SECRET,
        },
        body: "{}",
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      runId: "c1000000-0000-4000-8000-000000000001",
      digest: "aaaaaaaaaaaa",
      counts: { items: 2, histories: 3, images: 1 },
      durationMs: 125,
      cleanup: { attempted: 0, failed: 0 },
    })
  })

  it("rejects malformed JSON after authentication without running sync", async () => {
    const values = runtimeValues()
    let runs = 0
    const handler = createAdvertisingSyncHandler({
      getEnv: (name) => values[name as keyof typeof values],
      run: async () => {
        runs += 1
        return { ok: true }
      },
    })
    const response = await handler(
      new Request("https://target.example/sync", {
        method: "POST",
        headers: {
          "x-roadmap-sync-secret": values.ADVERTISING_SYNC_CRON_SECRET,
        },
        body: "{",
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
      message: "同步请求格式无效",
    })
    expect(runs).toBe(0)
  })

  it("rejects non-POST methods and maps busy to 409", async () => {
    const values = runtimeValues()
    const handler = createAdvertisingSyncHandler({
      getEnv: (name) => values[name as keyof typeof values],
      run: async () => {
        throw Object.assign(new Error("busy"), { code: "SYNC_BUSY" })
      },
    })
    const methodResponse = await handler(
      new Request("https://target.example/sync", { method: "GET" })
    )
    expect(methodResponse.status).toBe(405)

    const busyResponse = await handler(
      new Request("https://target.example/sync", {
        method: "POST",
        headers: {
          "x-roadmap-sync-secret": values.ADVERTISING_SYNC_CRON_SECRET,
        },
        body: "{}",
      })
    )
    expect(busyResponse.status).toBe(409)
    expect(await busyResponse.json()).toEqual({
      ok: false,
      code: "SYNC_BUSY",
      message: "广告系统同步正在运行",
    })
  })
})
