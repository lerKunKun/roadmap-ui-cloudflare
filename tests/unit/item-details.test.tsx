import { fireEvent, render, screen, within } from "@testing-library/react"
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
  hasImage: false,
  imageId: null,
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
  item?: RoadmapItem
  notice?: string | null
  onOpenChange?: (open: boolean) => void
  onVote?: (itemId: string) => void
}) {
  return render(
    <ItemDetails
      item={overrides?.item ?? item}
      notice={overrides?.notice ?? null}
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

  it("renders no image region when the item has no image", () => {
    renderDetails()

    expect(
      screen.queryByRole("region", { name: "建议图片" })
    ).not.toBeInTheDocument()
  })

  it("shows an audit notice without requesting pending image bytes", () => {
    renderDetails({ item: { ...item, status: "pending", hasImage: true } })

    expect(
      screen.getByText("图片正在审核，通过后将在此显示")
    ).toBeInTheDocument()
    expect(document.querySelector('img[src*="/media/"]')).toBeNull()
  })

  it("shows a rejection notice without requesting rejected image bytes", () => {
    renderDetails({ item: { ...item, status: "rejected", hasImage: true } })

    expect(screen.getByText("图片未通过审核，不对外显示")).toBeInTheDocument()
    expect(document.querySelector('img[src*="/media/"]')).toBeNull()
  })

  it.each(["approved", "in_progress", "completed"] as const)(
    "loads a %s image lazily from its canonical public URL",
    (status) => {
      const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      renderDetails({
        item: { ...item, status, hasImage: true, imageId },
      })

      const image = screen.getByRole("img", {
        name: `${item.title} 的建议图片`,
      })
      expect(image).toHaveAttribute("src", `/media/${imageId}`)
      expect(image).toHaveAttribute("loading", "lazy")
      expect(
        screen
          .getByRole("region", { name: "建议图片" })
          .querySelector('[data-slot="skeleton"]')
      ).toBeInTheDocument()
    }
  )

  it("replaces the loading skeleton with the contained image on success", () => {
    const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    renderDetails({ item: { ...item, hasImage: true, imageId } })
    const image = screen.getByRole("img", {
      name: `${item.title} 的建议图片`,
    })

    fireEvent.load(image)

    expect(image).toHaveClass("max-h-72", "object-contain", "opacity-100")
    expect(
      screen
        .getByRole("region", { name: "建议图片" })
        .querySelector('[data-slot="skeleton"]')
    ).toBeNull()
  })

  it("opens the public image in a large dialog and restores trigger focus", async () => {
    const user = userEvent.setup()
    const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    renderDetails({ item: { ...item, hasImage: true, imageId } })
    fireEvent.load(
      screen.getByRole("img", { name: `${item.title} 的建议图片` })
    )
    const trigger = screen.getByRole("button", {
      name: `查看“${item.title}”大图`,
    })

    await user.click(trigger)

    const lightbox = screen.getByRole("dialog", {
      name: `${item.title} 大图`,
    })
    expect(
      within(lightbox).getByRole("img", {
        name: `${item.title} 的建议图片（大图）`,
      })
    ).toHaveAttribute("src", `/media/${imageId}`)

    await user.click(
      within(lightbox).getByRole("button", { name: "关闭大图" })
    )
    expect(
      screen.queryByRole("dialog", { name: `${item.title} 大图` })
    ).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("keeps the rest of the dialog visible when an image fails", async () => {
    const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    renderDetails({ item: { ...item, hasImage: true, imageId } })
    fireEvent.error(
      screen.getByRole("img", { name: `${item.title} 的建议图片` })
    )

    expect(screen.getByText(item.description)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: `为“${item.title}”投票` })
    ).toHaveTextContent("8")
    expect(await screen.findByText("待处理 → 已批准")).toBeInTheDocument()
    expect(
      screen.getByText("票数仅用于辅助判断优先级，不代表明确交付承诺。")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "重新加载" })).toHaveClass(
      "border-border",
      "bg-background"
    )
  })

  it("retries by remounting the same canonical image URL", async () => {
    const user = userEvent.setup()
    const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    renderDetails({ item: { ...item, hasImage: true, imageId } })
    const firstImage = screen.getByRole("img", {
      name: `${item.title} 的建议图片`,
    })
    fireEvent.error(firstImage)

    await user.click(screen.getByRole("button", { name: "重新加载" }))

    const retriedImage = screen.getByRole("img", {
      name: `${item.title} 的建议图片`,
    })
    expect(retriedImage).not.toBe(firstImage)
    expect(retriedImage).toHaveAttribute("src", `/media/${imageId}`)
    expect(retriedImage.getAttribute("src")).not.toContain("?")
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

  it("shows vote feedback inside the open detail dialog", () => {
    renderDetails({ notice: "投票成功，感谢你的反馈" })

    expect(
      within(screen.getByRole("dialog")).getByRole("status")
    ).toHaveTextContent("投票成功，感谢你的反馈")
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
