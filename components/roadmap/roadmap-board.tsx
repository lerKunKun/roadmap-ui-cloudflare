import {
  CheckCircle2,
  CircleX,
  Clock3,
  Hammer,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ColumnPages } from "@/components/roadmap/column-pages"
import { RoadmapCard } from "@/components/roadmap/roadmap-card"
import {
  STATUS_COLUMNS,
  type RoadmapStatus,
} from "@/features/roadmap/types"
import type { RoadmapItem } from "@/features/roadmap/types"

interface RoadmapBoardProps {
  items: RoadmapItem[]
  onOpenItem(item: RoadmapItem): void
  onVote(itemId: string): void | Promise<void>
  votingItemId?: string | null
}

const STATUS_PRESENTATION: Record<
  RoadmapStatus,
  { icon: LucideIcon; accent: string; badge: string }
> = {
  pending: {
    icon: Clock3,
    accent: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  approved: {
    icon: ThumbsUp,
    accent: "text-blue-700 dark:text-blue-300",
    badge: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  in_progress: {
    icon: Hammer,
    accent: "text-violet-700 dark:text-violet-300",
    badge:
      "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  },
  completed: {
    icon: CheckCircle2,
    accent: "text-emerald-700 dark:text-emerald-300",
    badge:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  rejected: {
    icon: CircleX,
    accent: "text-rose-700 dark:text-rose-300",
    badge: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  },
}

export function RoadmapBoard({
  items,
  onOpenItem,
  onVote,
  votingItemId = null,
}: RoadmapBoardProps) {
  return (
    <div
      className="roadmap-board grid grid-flow-col gap-3 overflow-x-auto pb-3"
      aria-label="Roadmap 看板"
    >
      {STATUS_COLUMNS.map((column) => {
        const columnItems = items
          .filter((item) => item.status === column.value)
          .sort((left, right) =>
            left.sortOrder === right.sortOrder
              ? left.createdAt.localeCompare(right.createdAt)
              : left.sortOrder - right.sortOrder,
          )
        const presentation = STATUS_PRESENTATION[column.value]
        const StatusIcon = presentation.icon

        return (
          <section
            key={column.value}
            role="region"
            aria-label={column.label}
            className="flex min-h-0 min-w-0 flex-col rounded-xl border border-blue-100/80 bg-white/85 p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)] dark:border-white/10 dark:bg-card/80"
          >
            <header className="mb-3 flex shrink-0 items-center gap-2 border-b border-border/70 pb-3">
              <StatusIcon className={`size-4 ${presentation.accent}`} />
              <h2 className="text-sm font-semibold tracking-tight">
                {column.label}
              </h2>
              <Badge
                variant="secondary"
                className={`ml-auto min-w-7 justify-center border-0 tabular-nums ${presentation.badge}`}
              >
                {columnItems.length}
              </Badge>
            </header>

            <ColumnPages
              items={columnItems}
              renderItem={(item) => (
                  <RoadmapCard
                    key={item.id}
                    item={item}
                    voting={votingItemId === item.id}
                    onOpen={() => onOpenItem(item)}
                    onVote={() => onVote(item.id)}
                  />
              )}
              empty={
                <div className="flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed border-blue-100 bg-blue-50/30 px-4 text-center dark:border-white/10 dark:bg-white/[0.02]">
                  <p className="text-xs font-medium text-muted-foreground">
                    当前阶段暂无条目
                  </p>
                </div>
              }
            />
          </section>
        )
      })}
    </div>
  )
}
