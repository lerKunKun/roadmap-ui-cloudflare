import { ArrowBigUp, ArrowUpRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { RoadmapItem } from "@/features/roadmap/types"

interface RoadmapCardProps {
  item: RoadmapItem
  voting: boolean
  onOpen(): void
  onVote(): void | Promise<void>
}

export function RoadmapCard({
  item,
  voting,
  onOpen,
  onVote,
}: RoadmapCardProps) {
  return (
    <Card
      size="sm"
      className="gap-3 ring-blue-100 transition duration-150 hover:-translate-y-0.5 hover:shadow-md hover:ring-blue-200 dark:ring-white/10"
    >
      <CardHeader>
        <CardTitle className="pr-2 text-[0.9rem] leading-5">
          {item.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="line-clamp-2 min-h-9 text-xs leading-[1.15rem] text-muted-foreground">
          {item.description || "暂无详细说明"}
        </p>
      </CardContent>
      <CardFooter className="justify-between gap-2 border-border/70 bg-muted/25 px-3 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-xs text-muted-foreground"
          onClick={onOpen}
        >
          查看详情
          <ArrowUpRight data-icon="inline-end" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-14 border-blue-100 bg-white font-semibold tabular-nums text-primary hover:border-blue-200 hover:bg-blue-50 dark:bg-transparent"
          aria-label={`为“${item.title}”投票`}
          disabled={voting}
          onClick={onVote}
        >
          <ArrowBigUp data-icon="inline-start" />
          {item.voteCount}
        </Button>
      </CardFooter>
    </Card>
  )
}
