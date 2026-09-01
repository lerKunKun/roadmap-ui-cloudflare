import { describe, expect, it, vi } from "vitest"

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "inter" }),
  Geist_Mono: () => ({ variable: "mono" }),
}))

describe("deployment metadata", () => {
  it("publishes a build commit marker for production smoke verification", async () => {
    process.env.NEXT_PUBLIC_DEPLOY_COMMIT = "f".repeat(40)
    const { metadata } = await import("../../app/layout")

    expect(metadata.other?.["roadmap-deploy-commit"]).toBe("f".repeat(40))
  })
})
