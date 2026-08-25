import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("public environment contract", () => {
  it("documents every browser-side variable without exposing server secrets", async () => {
    const source = await readFile(".env.example", "utf8")

    expect(source).toContain("NEXT_PUBLIC_SUPABASE_URL=")
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=")
    expect(source).toContain("NEXT_PUBLIC_ADMIN_EMAIL=")
    expect(source).not.toContain("SERVICE_ROLE")
  })
})
