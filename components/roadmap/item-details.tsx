"use client"

import { ArrowBigUp, CalendarDays } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { ItemImage } from "@/components/roadmap/item-image"
import { ItemTimeline } from "@/components/roadmap/item-timeline"
import {
  buildRoadmapTimeline,
  formatRoadmapDate,
} from "@/features/roadmap/timeline"
import { STATUS_COLUMNS, type RoadmapItem } from "@/features/roadmap/types"
import { useRoadmapHistory } from "@/features/roadmap/use-roadmap-history"

interface ItemDetailsProps {
  item: RoadmapItem | null
  voting: boolean
  onOpenChange(open: boolean): void
  onVote(itemId: string): void | Promise<void>
}

export function ItemDetails({
  item,
  voting,
  onOpenChange,
  onVote,
}: ItemDetailsProps) {
  const status = STATUS_COLUMNS.find((column) => column.value === item?.status)
  const history = useRoadmapHistory(item?.id ?? null)
  const timelineGroups = item ? buildRoadmapTimeline(item, history.entries) : []

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {item ? (
          <>
            <DialogHeader className="gap-2 border-b px-5 py-4 pr-12">
              <Badge variant="secondary" className="w-fit">
                {status?.label}
              </Badge>
              <DialogTitle className="text-lg leading-6">
                {item.title}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-1.5 text-xs">
                <CalendarDays className="size-3.5" />
                创建于 {formatRoadmapDate(item.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div className="grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.85fr)]">
              <div className="p-5 md:border-r">
                <ItemImage key={item.id} item={item} />
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  详细说明
                </h3>
                <p className="text-sm leading-7 whitespace-pre-wrap">
                  {item.description || "该条目暂时没有补充说明。"}
                </p>
                <Separator className="my-6" />
                <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3">
                  <div>
                    <p className="text-sm font-medium">希望优先实现？</p>
                    <p className="text-xs text-muted-foreground">
                      同一公网 IP 对本条目只能投一票
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`为“${item.title}”投票`}
                    disabled={voting}
                    onClick={() => onVote(item.id)}
                  >
                    <ArrowBigUp data-icon="inline-start" />
                    {item.voteCount}
                  </Button>
                </div>
              </div>
              <div className="border-t md:border-t-0">
                <ItemTimeline
                  groups={timelineGroups}
                  loading={history.loading}
                  error={history.error}
                  onRetry={history.retry}
                />
              </div>
            </div>

            <DialogFooter className="m-0 justify-start rounded-none px-5 py-3 text-xs text-muted-foreground sm:justify-start">
              票数仅用于辅助判断优先级，不代表明确交付承诺。
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
