import { describe, expect, it } from "vitest"

import {
  assertSourceIdentity,
  hasValidSyncSecret,
  safeSyncError,
} from "../../supabase/functions/_shared/advertising-sync-security"

const SOURCE_REF = "abcdefghijklmnopqrst"

describe("advertising sync source identity", () => {
  it("accepts only the exact HTTPS Supabase project origin", () => {
    expect(
      assertSourceIdentity(
        `https://${SOURCE_REF}.supabase.co`,
        SOURCE_REF,
      ).origin,
    ).toBe(`https://${SOURCE_REF}.supabase.co`)
  })

  it.each([
    `http://${SOURCE_REF}.supabase.co`,
    `https://${SOURCE_REF}.supabase.co.evil.example`,
    `https://prefix-${SOURCE_REF}.supabase.co`,
    `https://user:password@${SOURCE_REF}.supabase.co`,
    `https://${SOURCE_REF}.supabase.co:444`,
    `https://${SOURCE_REF}.supabase.co/rest/v1`,
    `https://${SOURCE_REF}.supabase.co?x=1`,
    `https://${SOURCE_REF}.supabase.co#fragment`,
  ])("rejects unsafe source URL %s", (url) => {
    expect(() => assertSourceIdentity(url, SOURCE_REF)).toThrow(
      "源 Supabase 身份无效",
    )
  })

  it("rejects an invalid project ref before parsing the URL", () => {
    expect(() => assertSourceIdentity("https://example.com", "../escape")).toThrow(
      "源 Supabase 身份无效",
    )
  })
})

describe("advertising sync request secret", () => {
  it("accepts only the complete dedicated secret", async () => {
    const expected = "a".repeat(64)
    await expect(hasValidSyncSecret(expected, expected)).resolves.toBe(true)
    await expect(hasValidSyncSecret(`${"a".repeat(63)}b`, expected)).resolves.toBe(
      false,
    )
    await expect(hasValidSyncSecret("a".repeat(63), expected)).resolves.toBe(false)
    await expect(hasValidSyncSecret(null, expected)).resolves.toBe(false)
  })

  it("rejects a weak configured secret", async () => {
    await expect(hasValidSyncSecret("short", "short")).resolves.toBe(false)
  })
})

describe("advertising sync safe errors", () => {
  it("maps known codes without leaking upstream details", () => {
    const secret = "sb_secret_should_not_leak"
    const error = Object.assign(
      new Error(`provider body contained ${secret} and a customer title`),
      { code: "IMAGE_CONFLICT" },
    )

    const safe = safeSyncError(error)
    expect(safe).toEqual({
      code: "IMAGE_CONFLICT",
      message: "目标图片路径存在内容冲突",
    })
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(JSON.stringify(safe)).not.toContain("customer title")
  })

  it("maps unknown failures to a fixed internal error", () => {
    expect(safeSyncError(new Error("database response body"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "同步失败，请查看安全日志代码",
    })
  })
})
