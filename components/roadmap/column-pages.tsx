"use client"

import { useRef, useState, type ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { RoadmapItem } from "@/features/roadmap/types"

const PAGE_SIZE = 4

export function ColumnPages({ items, empty, renderItem }: {
  items: RoadmapItem[]
  empty: ReactNode
  renderItem(item: RoadmapItem): ReactNode
}) {
  const [page, setPage] = useState(1)
  const list = useRef<HTMLDivElement>(null)
  const lastPage = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const currentPage = Math.min(page, lastPage)
  if (currentPage !== page) setPage(currentPage)
  const start = (currentPage - 1) * PAGE_SIZE

  function goTo(nextPage: number) {
    setPage(nextPage)
    if (list.current) list.current.scrollTop = 0
  }

  return (
    <>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="grid gap-2.5">
          {items.length ? items.slice(start, start + PAGE_SIZE).map(renderItem) : empty}
        </div>
      </div>
      {lastPage > 1 ? (
        <div className="mt-2 flex shrink-0 items-center justify-between gap-1 border-t pt-2">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="上一页"
            disabled={currentPage === 1} onClick={() => goTo(currentPage - 1)}>
            <ChevronLeft />
          </Button>
          <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
            {currentPage} / {lastPage} 页
          </span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="下一页"
            disabled={currentPage === lastPage} onClick={() => goTo(currentPage + 1)}>
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </>
  )
}
