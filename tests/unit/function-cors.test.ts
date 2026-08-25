import { describe, expect, it } from "vitest"

import {
  getCorsHeaders,
  parseAllowedOrigins,
} from "../../supabase/functions/_shared/cors"

describe("Edge Function origin allowlist", () => {
  it("allows the exact configured production origin", () => {
    const allowed = parseAllowedOrigins(
      "https://roadmap.acme.cn, https://preview.acme.cn",
    )

    expect(getCorsHeaders("https://roadmap.acme.cn", allowed)).toMatchObject({
      "Access-Control-Allow-Origin": "https://roadmap.acme.cn",
      Vary: "Origin",
    })
  })

  it("rejects lookalike and missing origins", () => {
    const allowed = parseAllowedOrigins("https://roadmap.acme.cn")

    expect(getCorsHeaders("https://roadmap.acme.cn.evil.test", allowed)).toBeNull()
    expect(getCorsHeaders(null, allowed)).toBeNull()
  })

  it("always includes the two explicit local development origins", () => {
    const allowed = parseAllowedOrigins(undefined)

    expect(getCorsHeaders("http://localhost:3000", allowed)).not.toBeNull()
    expect(getCorsHeaders("http://127.0.0.1:3000", allowed)).not.toBeNull()
  })
})
