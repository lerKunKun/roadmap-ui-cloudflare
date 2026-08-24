"use client"

import { ArrowBigUp, CalendarDays } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { STATUS_COLUMNS, type RoadmapItem } from "@/features/roadmap/types"

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

  return (
    <Sheet open={Boolean(item)} onOpenChange={onOpenChange}>
      <SheetContent className="w-[90vw] sm:max-w-md">
        {item ? (
          <>
            <SheetHeader className="gap-2 border-b pr-12">
              <Badge variant="secondary" className="w-fit">
                {status?.label}
              </Badge>
              <SheetTitle className="text-lg leading-6">{item.title}</SheetTitle>
              <SheetDescription className="flex items-center gap-1.5 text-xs">
                <CalendarDays className="size-3.5" />
                提交于
                {new Intl.DateTimeFormat("zh-CN", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }).format(new Date(item.createdAt))}
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-4">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                详细说明
              </h3>
              <p className="whitespace-pre-wrap text-sm leading-7">
                {item.description || "该条目暂时没有补充说明。"}
              </p>
              <Separator className="my-6" />
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
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
            <SheetFooter className="border-t text-xs text-muted-foreground">
              票数仅用于辅助判断优先级，不代表明确交付承诺。
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
