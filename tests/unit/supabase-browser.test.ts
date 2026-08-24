import { afterEach, describe, expect, it, vi } from "vitest"

describe("Supabase browser client", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("reports a readable error when public configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    const { getSupabaseBrowserClient } = await import(
      "@/lib/supabase/browser"
    )

    expect(() => getSupabaseBrowserClient()).toThrow(
      "Roadmap 尚未配置 Supabase 连接",
    )
  })

  it("reuses one configured client in the browser bundle", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SUPABASE_URL",
      "https://abcdefghijklmnopqrst.supabase.co",
    )
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-test-key")
    const { getSupabaseBrowserClient } = await import(
      "@/lib/supabase/browser"
    )

    expect(getSupabaseBrowserClient()).toBe(getSupabaseBrowserClient())
  })
})
