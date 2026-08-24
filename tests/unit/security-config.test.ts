import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("production security configuration", () => {
  it("adds Cloudflare security headers with a restricted connection policy", async () => {
    const headers = await readFile("public/_headers", "utf8")

    expect(headers).toContain("Content-Security-Policy:")
    expect(headers).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co")
    expect(headers).toContain("X-Content-Type-Options: nosniff")
    expect(headers).toContain("X-Frame-Options: DENY")
    expect(headers).toContain("Strict-Transport-Security: max-age=31536000")
    expect(headers).toContain("Permissions-Policy:")
    expect(headers).not.toContain("connect-src *")
  })

  it("blocks public signup while keeping password login enabled", async () => {
    const config = await readFile("supabase/config.toml", "utf8")

    expect(config).toMatch(/\[auth\][\s\S]*?enable_signup = false/)
    expect(config).toMatch(/\[auth\.email\][\s\S]*?enable_signup = true/)
  })
})
