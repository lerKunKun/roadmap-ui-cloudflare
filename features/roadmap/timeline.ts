import {
  STATUS_COLUMNS,
  type RoadmapItem,
  type RoadmapReply,
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
  replies: RoadmapReply[] = [],
): RoadmapTimelineGroup[] {
  const createdDate = formatRoadmapDate(item.createdAt)
  const createdEvent: RoadmapTimelineEvent = {
    key: "created",
    kind: "created",
    label: "任务创建",
  }
  const groups = new Map<string, { time: number; event: RoadmapTimelineEvent }[]>()
  groups.set(createdDate, [{ time: -Infinity, event: createdEvent }])
  let mergedInitialStatus = false

  function addEvent(date: string, timestamp: string, event: RoadmapTimelineEvent) {
    const entry = { time: Date.parse(timestamp), event }
    const events = groups.get(date)
    if (events) events.push(entry)
    else groups.set(date, [entry])
  }

  const sortedHistory = [...history].sort((left, right) => {
    const timeOrder = Date.parse(left.changedAt) - Date.parse(right.changedAt)
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

    addEvent(date, entry.changedAt, event)
  }

  for (const reply of replies) {
    addEvent(formatRoadmapDate(reply.createdAt), reply.createdAt, {
      key: `reply-${reply.id}`,
      kind: "reply",
      label: "管理员回复",
      body: reply.body,
    })
  }

  return [...groups.entries()]
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([date, events]) => ({
      date,
      events: events.sort((left, right) => left.time - right.time).map(({ event }) => event),
    }))
}
