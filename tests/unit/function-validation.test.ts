import { describe, expect, it } from "vitest"

import {
  suggestionSchema,
  voteSchema,
} from "../../supabase/functions/_shared/validation"

const projectId = "11111111-1111-4111-8111-111111111111"

describe("anonymous function payloads", () => {
  it("trims a valid suggestion and keeps only public fields", () => {
    expect(
      suggestionSchema.parse({
        projectId,
        title: "  增加导出功能  ",
        description: "  支持 CSV  ",
      }),
    ).toEqual({
      projectId,
      title: "增加导出功能",
      description: "支持 CSV",
    })
  })

  it("rejects attempts to choose a suggestion status", () => {
    expect(
      suggestionSchema.safeParse({
        projectId,
        title: "增加导出功能",
        description: "",
        status: "completed",
      }).success,
    ).toBe(false)
  })

  it("enforces suggestion title boundaries", () => {
    expect(
      suggestionSchema.safeParse({
        projectId,
        title: "一",
        description: "",
      }).success,
    ).toBe(false)
    expect(
      suggestionSchema.safeParse({
        projectId,
        title: "一".repeat(121),
        description: "",
      }).success,
    ).toBe(false)
  })

  it("accepts only a UUID item identifier for voting", () => {
    expect(voteSchema.safeParse({ roadmapItemId: projectId }).success).toBe(true)
    expect(voteSchema.safeParse({ roadmapItemId: "item-1" }).success).toBe(false)
  })
})
