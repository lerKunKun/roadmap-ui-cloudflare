import { describe, expect, it } from "vitest"

import {
  buildRoadmapTimeline,
  formatRoadmapDate,
} from "@/features/roadmap/timeline"
import type {
  RoadmapItem,
  RoadmapStatusHistoryEntry,
} from "@/features/roadmap/types"

const item: RoadmapItem = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "告警通知聚合",
  description: "",
  status: "in_progress",
  sortOrder: 0,
  voteCount: 0,
  hasImage: false,
  imageId: null,
  createdAt: "2026-08-24T15:30:00.000Z",
  updatedAt: "2026-08-25T02:00:00.000Z",
}

describe("Roadmap timeline", () => {
  it("formats the day in Asia/Shanghai", () => {
    expect(formatRoadmapDate("2026-08-24T16:30:00.000Z")).toBe(
      "2026-08-25",
    )
  })

  it("merges a same-day null baseline into task creation", () => {
    const history: RoadmapStatusHistoryEntry[] = [
      {
        id: 1,
        roadmapItemId: item.id,
        fromStatus: null,
        toStatus: "pending",
        changedAt: "2026-08-24T15:31:00.000Z",
      },
    ]

    expect(buildRoadmapTimeline(item, history)).toEqual([
      {
        date: "2026-08-24",
        events: [
          {
            key: "created",
            kind: "created",
            label: "任务创建",
            toStatus: "pending",
          },
        ],
      },
    ])
  })

  it("shows a later null baseline as the current status", () => {
    const history: RoadmapStatusHistoryEntry[] = [
      {
        id: 4,
        roadmapItemId: item.id,
        fromStatus: null,
        toStatus: "in_progress",
        changedAt: "2026-08-25T02:00:00.000Z",
      },
    ]

    expect(buildRoadmapTimeline(item, history)).toEqual([
      {
        date: "2026-08-24",
        events: [
          {
            key: "created",
            kind: "created",
            label: "任务创建",
          },
        ],
      },
      {
        date: "2026-08-25",
        events: [
          {
            key: "history-4",
            kind: "baseline",
            label: "当前状态",
            toStatus: "in_progress",
          },
        ],
      },
    ])
  })

  it("sorts and preserves every real transition in a shared day group", () => {
    const history: RoadmapStatusHistoryEntry[] = [
      {
        id: 3,
        roadmapItemId: item.id,
        fromStatus: "approved",
        toStatus: "in_progress",
        changedAt: "2026-08-25T02:00:00.000Z",
      },
      {
        id: 1,
        roadmapItemId: item.id,
        fromStatus: null,
        toStatus: "pending",
        changedAt: item.createdAt,
      },
      {
        id: 2,
        roadmapItemId: item.id,
        fromStatus: "pending",
        toStatus: "approved",
        changedAt: "2026-08-25T01:00:00.000Z",
      },
    ]

    expect(buildRoadmapTimeline(item, history)[1].events).toEqual([
      {
        key: "history-2",
        kind: "transition",
        label: "待处理 → 已批准",
        fromStatus: "pending",
        toStatus: "approved",
      },
      {
        key: "history-3",
        kind: "transition",
        label: "已批准 → 进行中",
        fromStatus: "approved",
        toStatus: "in_progress",
      },
    ])
  })
})
