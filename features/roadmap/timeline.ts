import {
  STATUS_COLUMNS,
  type RoadmapItem,
  type RoadmapStatus,
  type RoadmapStatusHistoryEntry,
  type RoadmapTimelineEvent,
  type RoadmapTimelineGroup,
} from "@/features/roadmap/types"

const chinaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const statusLabels = new Map<RoadmapStatus, string>(
  STATUS_COLUMNS.map((column) => [column.value, column.label]),
)

export function formatRoadmapDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error("Roadmap 日期无效")
  }

  const parts = Object.fromEntries(
    chinaDateFormatter
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )

  return `${parts.year}-${parts.month}-${parts.day}`
}

function statusLabel(status: RoadmapStatus): string {
  return statusLabels.get(status) ?? status
}

export function buildRoadmapTimeline(
  item: RoadmapItem,
  history: RoadmapStatusHistoryEntry[],
): RoadmapTimelineGroup[] {
  const createdDate = formatRoadmapDate(item.createdAt)
  const createdEvent: RoadmapTimelineEvent = {
    key: "created",
    kind: "created",
    label: "任务创建",
  }
  const groups = new Map<string, RoadmapTimelineEvent[]>([
    [createdDate, [createdEvent]],
  ])
  let mergedInitialStatus = false

  const sortedHistory = [...history].sort((left, right) => {
    const timeOrder = left.changedAt.localeCompare(right.changedAt)
    return timeOrder === 0 ? left.id - right.id : timeOrder
  })

  for (const entry of sortedHistory) {
    const date = formatRoadmapDate(entry.changedAt)

    if (
      entry.fromStatus === null &&
      date === createdDate &&
      !mergedInitialStatus
    ) {
      createdEvent.toStatus = entry.toStatus
      mergedInitialStatus = true
      continue
    }

    const event: RoadmapTimelineEvent = entry.fromStatus === null
      ? {
          key: `history-${entry.id}`,
          kind: "baseline",
          label: "当前状态",
          toStatus: entry.toStatus,
        }
      : {
          key: `history-${entry.id}`,
          kind: "transition",
          label: `${statusLabel(entry.fromStatus)} → ${statusLabel(entry.toStatus)}`,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
        }

    const events = groups.get(date)
    if (events) {
      events.push(event)
    } else {
      groups.set(date, [event])
    }
  }

  return [...groups.entries()]
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([date, events]) => ({ date, events }))
}
