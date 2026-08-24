import { describe, expect, it } from "vitest"

import { generatePassword } from "../../scripts/generate-admin-password.mjs"

describe("admin password generator", () => {
  it("生成至少 32 位且包含四类字符的强密码", () => {
    const password = generatePassword()

    expect(password.length).toBeGreaterThanOrEqual(32)
    expect(password).toMatch(/[A-Z]/)
    expect(password).toMatch(/[a-z]/)
    expect(password).toMatch(/[0-9]/)
    expect(password).toMatch(/[!@#$%^&*]/)
    expect(password).not.toMatch(/\s/)
  })

  it("连续生成结果不重复", () => {
    expect(generatePassword()).not.toBe(generatePassword())
  })
})
