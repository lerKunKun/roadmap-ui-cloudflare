import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ItemDetails } from "@/components/roadmap/item-details"
import { listRoadmapStatusHistory } from "@/features/roadmap/api"
import type {
  RoadmapItem,
  RoadmapStatusHistoryEntry,
} from "@/features/roadmap/types"

vi.mock("@/features/roadmap/api", () => ({
  listRoadmapStatusHistory: vi.fn(),
}))

const item: RoadmapItem = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "告警通知聚合",
  description: "集中展示来自多个来源的告警通知。",
  status: "approved",
  sortOrder: 0,
  voteCount: 8,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T16:30:00.000Z",
}

const history: RoadmapStatusHistoryEntry[] = [
  {
    id: 1,
    roadmapItemId: item.id,
    fromStatus: null,
    toStatus: "pending",
    changedAt: item.createdAt,
  },
  {
    id: 2,
    roadmapItemId: item.id,
    fromStatus: "pending",
    toStatus: "approved",
    changedAt: "2026-08-24T16:30:00.000Z",
  },
]

function renderDetails(overrides?: {
  onOpenChange?: (open: boolean) => void
  onVote?: (itemId: string) => void
}) {
  return render(
    <ItemDetails
      item={item}
      voting={false}
      onOpenChange={overrides?.onOpenChange ?? vi.fn()}
      onVote={overrides?.onVote ?? vi.fn()}
    />
  )
}

describe("ItemDetails", () => {
  beforeEach(() => {
    vi.mocked(listRoadmapStatusHistory).mockReset()
    vi.mocked(listRoadmapStatusHistory).mockResolvedValue(history)
  })

  it("renders item details and status history in a dialog", async () => {
    renderDetails()

    const dialog = screen.getByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: item.title })
    ).toBeInTheDocument()
    expect(within(dialog).getByText(item.description)).toBeInTheDocument()
    expect(
      await within(dialog).findByText("待处理 → 已批准")
    ).toBeInTheDocument()
    expect(within(dialog).getByText("2026-08-25")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
  })

  it("shows timeline loading without hiding item details", () => {
    vi.mocked(listRoadmapStatusHistory).mockReturnValue(
      new Promise(() => undefined)
    )
    renderDetails()

    const timeline = screen.getByRole("region", { name: "进展时间轴" })
    expect(timeline.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
    expect(screen.getByText(item.description)).toBeInTheDocument()
  })

  it("retries a failed timeline request", async () => {
    const user = userEvent.setup()
    vi.mocked(listRoadmapStatusHistory)
      .mockRejectedValueOnce(new Error("时间轴暂时不可用"))
      .mockResolvedValueOnce(history)
    renderDetails()

    expect(await screen.findByText("时间轴暂时不可用")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "重新加载" }))

    expect(await screen.findByText("待处理 → 已批准")).toBeInTheDocument()
  })

  it("preserves voting from the detail dialog", async () => {
    const user = userEvent.setup()
    const onVote = vi.fn()
    renderDetails({ onVote })

    await user.click(
      screen.getByRole("button", { name: `为“${item.title}”投票` })
    )
    expect(onVote).toHaveBeenCalledWith(item.id)
  })

  it("notifies the parent when the dialog closes", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderDetails({ onOpenChange })

    await user.click(screen.getByRole("button", { name: "关闭" }))
    expect(onOpenChange).toHaveBeenCalled()
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false)
  })
})
