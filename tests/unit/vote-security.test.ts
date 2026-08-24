import { describe, expect, it } from "vitest"

import {
  hashIp,
  normalizeIp,
} from "../../supabase/functions/_shared/vote-security"

describe("vote IP protection", () => {
  it("maps IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  it("canonicalizes equivalent IPv6 values", () => {
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe("2001:db8::1")
  })

  it("rejects malformed addresses", () => {
    expect(() => normalizeIp("203.0.113.7, 198.51.100.4")).toThrow(
      "无效的来源 IP",
    )
  })

  it("creates a stable non-reversible identifier", async () => {
    const first = await hashIp("203.0.113.7", "test-salt")
    const second = await hashIp("203.0.113.7", "test-salt")

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain("203.0.113.7")
  })

  it("changes the identifier when the private salt changes", async () => {
    const first = await hashIp("203.0.113.7", "first-salt")
    const second = await hashIp("203.0.113.7", "second-salt")

    expect(first).not.toBe(second)
  })
})
