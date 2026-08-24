import { describe, expect, it } from "vitest"

import {
  STATUS_COLUMNS,
  isRoadmapStatus,
} from "@/features/roadmap/types"

describe("roadmap status model", () => {
  it("keeps the five required statuses in display order", () => {
    expect(STATUS_COLUMNS.map((column) => column.value)).toEqual([
      "pending",
      "approved",
      "in_progress",
      "completed",
      "rejected",
    ])
  })

  it("rejects unknown statuses", () => {
    expect(isRoadmapStatus("archived")).toBe(false)
  })
})
