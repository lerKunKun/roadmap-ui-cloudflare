import { describe, expect, it } from "vitest"

import {
  mapProjectRow,
  mapRoadmapItemRow,
  mapRoadmapStatusHistoryRow,
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

  it("maps a status history row into the UI model", () => {
    expect(
      mapRoadmapStatusHistoryRow({
        id: 7,
        roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        from_status: "approved",
        to_status: "in_progress",
        changed_at: "2026-08-24T16:30:00.000Z",
      }),
    ).toEqual({
      id: 7,
      roadmapItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fromStatus: "approved",
      toStatus: "in_progress",
      changedAt: "2026-08-24T16:30:00.000Z",
    })
  })

  it("refuses unknown database statuses in history", () => {
    expect(() =>
      mapRoadmapStatusHistoryRow({
        id: 8,
        roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        from_status: "approved",
        to_status: "archived",
        changed_at: "2026-08-24T16:30:00.000Z",
      }),
    ).toThrow("Roadmap 状态历史无效")
  })
})
