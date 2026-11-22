export const STATUS_COLUMNS = [
  { value: "pending", label: "待处理" },
  { value: "approved", label: "已批准" },
  { value: "in_progress", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "rejected", label: "已拒绝" },
] as const

export type RoadmapStatus = (typeof STATUS_COLUMNS)[number]["value"]

export function isRoadmapStatus(value: string): value is RoadmapStatus {
  return STATUS_COLUMNS.some((column) => column.value === value)
}

export interface Project {
  id: string
  name: string
  slug: string
  projectUrl: string | null
  sortOrder: number
}

export interface RoadmapItem {
  id: string
  projectId: string
  title: string
  description: string
  status: RoadmapStatus
  sortOrder: number
  voteCount: number
  hasImage: boolean
  imageId: string | null
  createdAt: string
  updatedAt: string
}

export interface RoadmapStatusHistoryEntry {
  id: number
  roadmapItemId: string
  fromStatus: RoadmapStatus | null
  toStatus: RoadmapStatus
  changedAt: string
}

export interface RoadmapReply {
  id: string
  body: string
  createdAt: string
}

export type RoadmapTimelineEvent =
  | { key: string; kind: "reply"; label: string; body: string }
  | {
      key: string
      kind: "created"
      label: string
      toStatus?: RoadmapStatus
    }
  | {
      key: string
      kind: "baseline"
      label: string
      toStatus: RoadmapStatus
    }
  | {
      key: string
      kind: "transition"
      label: string
      fromStatus: RoadmapStatus
      toStatus: RoadmapStatus
    }

export interface RoadmapTimelineGroup {
  date: string
  events: RoadmapTimelineEvent[]
}

export interface SuggestionInput {
  projectId: string
  title: string
  description: string
  image: File | null
}

export interface VoteResult {
  voteCount: number
  duplicate: boolean
}
