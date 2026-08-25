import { describe, expect, it } from "vitest"

import {
  mapProjectRow,
  mapRoadmapItemRow,
} from "@/features/roadmap/api"

describe("Roadmap API mapping", () => {
  it("maps database project fields into the UI model", () => {
    expect(
      mapProjectRow({
        id: "project-1",
        name: "广告系统",
        slug: "advertising-system",
        project_url: "https://ads.example.test",
        sort_order: 2,
      }),
    ).toEqual({
      id: "project-1",
      name: "广告系统",
      slug: "advertising-system",
      projectUrl: "https://ads.example.test",
      sortOrder: 2,
    })
  })

  it("converts bigint vote counts to a safe display number", () => {
    expect(
      mapRoadmapItemRow({
        id: "item-1",
        project_id: "project-1",
        title: "导出报表",
        description: "支持 CSV",
        status: "approved",
        sort_order: 1,
        vote_count: "42",
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      }).voteCount,
    ).toBe(42)
  })

  it("refuses unknown database statuses", () => {
    expect(() =>
      mapRoadmapItemRow({
        id: "item-1",
        project_id: "project-1",
        title: "导出报表",
        description: "",
        status: "archived",
        sort_order: 1,
        vote_count: 0,
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      }),
    ).toThrow("Roadmap 状态无效")
  })
})
