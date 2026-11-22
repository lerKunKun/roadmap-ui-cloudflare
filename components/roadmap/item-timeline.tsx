import { Clock3, MessageSquare, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  STATUS_COLUMNS,
  type RoadmapStatus,
  type RoadmapTimelineEvent,
  type RoadmapTimelineGroup,
} from "@/features/roadmap/types"

interface ItemTimelineProps {
  groups: RoadmapTimelineGroup[]
  loading: boolean
  error: string | null
  onRetry(): void
}

const statusLabels = new Map<RoadmapStatus, string>(
  STATUS_COLUMNS.map((column) => [column.value, column.label])
)

function statusLabel(status: RoadmapStatus): string {
  return statusLabels.get(status) ?? status
}

function eventDetail(event: RoadmapTimelineEvent): string | null {
  if (event.kind === "created" && event.toStatus) {
    return `初始状态：${statusLabel(event.toStatus)}`
  }

  if (event.kind === "baseline") {
    return `状态：${statusLabel(event.toStatus)}`
  }

  return null
}

function TimelineLoading() {
  return (
    <div className="space-y-5" aria-label="正在加载时间轴">
      {[0, 1, 2].map((index) => (
        <div key={index} className="grid grid-cols-[4.5rem_1fr] gap-3">
          <Skeleton className="col-span-2 h-4 w-full max-w-44" />
        </div>
      ))}
    </div>
  )
}

export function ItemTimeline({
  groups,
  loading,
  error,
  onRetry,
}: ItemTimelineProps) {
  return (
    <section aria-label="进展时间轴" className="p-5">
      <div className="mb-5 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Clock3 className="size-4" />
        </span>
        <h3 className="text-sm font-semibold">进展时间轴</h3>
      </div>

      {loading ? <TimelineLoading /> : null}

      {!loading && error ? (
        <div className="rounded-lg border border-dashed p-4">
          <p className="mb-3 text-sm text-muted-foreground">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw data-icon="inline-start" />
            重新加载
          </Button>
        </div>
      ) : null}

      {!loading && !error ? (
        <ol className="space-y-5">
          {groups.map((group) => (
            <li
              key={group.date}
              className="grid min-w-0 gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-3"
            >
              <time
                dateTime={group.date}
                className="pt-0.5 font-mono text-[0.7rem] text-muted-foreground"
              >
                {group.date}
              </time>
              <div className="space-y-4 border-l pl-4">
                {group.events.map((event) => {
                  const detail = eventDetail(event)

                  return (
                    <div key={event.key} className="relative min-w-0">
                      <span className="absolute top-1.5 -left-[1.25rem] size-2 rounded-full border-2 border-background bg-primary ring-1 ring-primary/25" />
                      {event.kind === "reply" ? (
                        <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                            <MessageSquare aria-hidden="true" className="size-3.5" />
                            {event.label}
                          </p>
                          <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
                            {event.body}
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm leading-5 font-medium">{event.label}</p>
                      )}
                      {detail ? (
                        <Badge variant="secondary" className="mt-1.5">
                          {detail}
                        </Badge>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
