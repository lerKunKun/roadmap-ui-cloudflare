import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { RoadmapBoard } from "@/components/roadmap/roadmap-board"
import {
  STATUS_COLUMNS,
  type RoadmapItem,
} from "@/features/roadmap/types"

const items: RoadmapItem[] = STATUS_COLUMNS.map((column, index) => ({
  id: `item-${index + 1}`,
  projectId: "project-1",
  title: index === 0 ? "导出报表" : `${column.label}条目`,
  description: `${column.label}阶段的说明`,
  status: column.value,
  sortOrder: index,
  voteCount: index + 3,
  hasImage: false,
  imageId: null,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
}))

describe("RoadmapBoard", () => {
  it("pages each status independently without changing the column total", async () => {
    const user = userEvent.setup()
    const extraItems = ["pending", "approved"] as const
    render(<RoadmapBoard
      items={extraItems.flatMap((status, column) =>
        Array.from({ length: 5 }, (_, i) => ({
          ...items[column],
          id: `${status}-${i}`,
          title: `${status} ${i + 1}`,
          sortOrder: i,
        }))
      )}
      onOpenItem={vi.fn()}
      onVote={vi.fn()}
    />)

    const pending = within(screen.getByRole("region", { name: "待处理" }))
    const approved = within(screen.getByRole("region", { name: "已批准" }))
    expect(pending.queryByText("pending 5")).not.toBeInTheDocument()
    await user.click(pending.getByRole("button", { name: "下一页" }))
    expect(pending.getByText("pending 5")).toBeInTheDocument()
    expect(pending.queryByText("pending 1")).not.toBeInTheDocument()
    expect(approved.getByText("approved 1")).toBeInTheDocument()
    expect(pending.getByText("5", { selector: "[data-slot=badge]" })).toBeInTheDocument()
  })

  it("renders the five required columns in product order", () => {
    render(
      <RoadmapBoard
        items={items}
        onOpenItem={vi.fn()}
        onVote={vi.fn()}
      />,
    )

    expect(
      screen
        .getAllByRole("region")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["待处理", "已批准", "进行中", "已完成", "已拒绝"])
    expect(screen.getByText("导出报表")).toBeInTheDocument()
    expect(screen.getByText("7")).toBeInTheDocument()
  })

  it("shows a useful empty state in every column", () => {
    render(
      <RoadmapBoard items={[]} onOpenItem={vi.fn()} onVote={vi.fn()} />,
    )

    expect(screen.getAllByText("当前阶段暂无条目")).toHaveLength(5)
  })

  it("votes for the exact item selected by the user", async () => {
    const user = userEvent.setup()
    const onVote = vi.fn()
    render(
      <RoadmapBoard
        items={items}
        onOpenItem={vi.fn()}
        onVote={onVote}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: "为“导出报表”投票" }),
    )

    expect(onVote).toHaveBeenCalledWith("item-1")
  })
})
