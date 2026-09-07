import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ItemDialog } from "@/components/admin/item-dialog"
import { getAdminRoadmapItemImage } from "@/features/roadmap/admin-api"
import type { RoadmapItem } from "@/features/roadmap/types"

vi.mock("@/features/roadmap/admin-api", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/roadmap/admin-api")>()
  return { ...original, getAdminRoadmapItemImage: vi.fn() }
})

const item: RoadmapItem = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "告警通知聚合",
  description: "集中展示来自多个来源的告警通知。",
  status: "pending",
  sortOrder: 0,
  voteCount: 0,
  hasImage: true,
  imageId: null,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T16:30:00.000Z",
}

const preview = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  signedUrl: "https://storage.example.test/private-preview",
  mimeType: "image/png",
  sizeBytes: 128,
  width: 20,
  height: 10,
}

function deferredValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderDialog(overrides?: {
  item?: RoadmapItem | null
  onOpenChange?: (open: boolean) => void
  onSave?: () => Promise<void>
}) {
  return render(
    <ItemDialog
      item={overrides?.item === undefined ? item : overrides.item}
      projectId={item.projectId}
      nextSortOrder={1}
      onOpenChange={overrides?.onOpenChange ?? vi.fn()}
      onSave={overrides?.onSave ?? vi.fn().mockResolvedValue(undefined)}
    />
  )
}

describe("ItemDialog admin image preview", () => {
  beforeEach(() => {
    vi.mocked(getAdminRoadmapItemImage).mockReset()
    vi.mocked(getAdminRoadmapItemImage).mockResolvedValue(preview)
  })

  it("只为已有条目加载预览并显示独立骨架", () => {
    vi.mocked(getAdminRoadmapItemImage).mockReturnValue(
      new Promise(() => undefined)
    )
    renderDialog()

    const region = screen.getByRole("region", { name: "建议图片" })
    expect(region).toHaveClass("rounded-lg", "border", "bg-muted/30")
    expect(region.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
    expect(screen.getByLabelText("标题")).toBeEnabled()
    expect(screen.getByLabelText("当前阶段")).toBeEnabled()
    expect(getAdminRoadmapItemImage).toHaveBeenCalledWith(item.id)
  })

  it("新建条目不加载或显示图片审核区域", () => {
    renderDialog({ item: null })

    expect(getAdminRoadmapItemImage).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("region", { name: "建议图片" })
    ).not.toBeInTheDocument()
  })

  it("新建条目默认今天并提交所选的过去创建日期", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const today = new Date()
    const expectedToday = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-")
    renderDialog({ item: null, onSave })

    const dateInput = screen.getByLabelText("创建日期")
    expect(dateInput).toHaveAttribute("type", "date")
    expect(dateInput).toHaveAttribute("max", expectedToday)
    expect(dateInput).toHaveValue(expectedToday)

    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "历史 Roadmap 条目" },
    })
    fireEvent.change(dateInput, { target: { value: "2025-03-08" } })
    fireEvent.submit(dateInput.closest("form")!)

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ createdDate: "2025-03-08" })
      )
    })
  })

  it("编辑已有条目时不显示创建日期控件", () => {
    renderDialog()

    expect(screen.queryByLabelText("创建日期")).not.toBeInTheDocument()
  })

  it("显示签名预览并使用包含布局和可访问替代文本", async () => {
    renderDialog()

    const image = await screen.findByRole("img", {
      name: `待审核建议图片：${item.title}`,
    })
    expect(image).toHaveAttribute("src", preview.signedUrl)
    expect(image).toHaveClass("object-contain")
    expect(screen.getByRole("region", { name: "建议图片" })).toHaveClass(
      "rounded-lg",
      "border",
      "bg-muted/30"
    )
  })

  it("点击签名预览后打开管理端大图并恢复触发器焦点", async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByRole("img", {
      name: `待审核建议图片：${item.title}`,
    })
    const trigger = screen.getByRole("button", {
      name: `查看“${item.title}”大图`,
    })

    await user.click(trigger)

    const lightbox = screen.getByRole("dialog", {
      name: `${item.title} 大图`,
    })
    expect(
      within(lightbox).getByRole("img", {
        name: `待审核建议图片：${item.title}（大图）`,
      })
    ).toHaveAttribute("src", preview.signedUrl)

    await user.click(
      within(lightbox).getByRole("button", { name: "关闭大图" })
    )
    expect(
      screen.queryByRole("dialog", { name: `${item.title} 大图` })
    ).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("预览加载失败后可重试且不妨碍编辑标题和阶段", async () => {
    const user = userEvent.setup()
    vi.mocked(getAdminRoadmapItemImage)
      .mockRejectedValueOnce(
        new Error("cannot sign suggestions/private/internal-name.png")
      )
      .mockResolvedValueOnce(preview)
    renderDialog()

    expect(
      await screen.findByText("建议图片加载失败，请重试")
    ).toBeInTheDocument()
    const title = screen.getByLabelText("标题")
    const status = screen.getByLabelText("当前阶段")
    await user.clear(title)
    await user.type(title, "更新后的标题")
    await user.selectOptions(status, "approved")
    expect(title).toHaveValue("更新后的标题")
    expect(status).toHaveValue("approved")

    const retry = screen.getByRole("button", { name: "重新加载" })
    expect(retry).toHaveClass("border-border", "bg-background")
    await user.click(retry)

    expect(
      await screen.findByRole("img", {
        name: `待审核建议图片：${item.title}`,
      })
    ).toHaveAttribute("src", preview.signedUrl)
    expect(getAdminRoadmapItemImage).toHaveBeenCalledTimes(2)
  })

  it("预览仍在加载时可保存修改后的标题和阶段", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getAdminRoadmapItemImage).mockReturnValue(
      new Promise(() => undefined)
    )
    renderDialog({ onSave })

    await user.clear(screen.getByLabelText("标题"))
    await user.type(screen.getByLabelText("标题"), "更新后的标题")
    await user.selectOptions(screen.getByLabelText("当前阶段"), "approved")
    await user.click(screen.getByRole("button", { name: "保存条目" }))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: "更新后的标题", status: "approved" })
    )
  })

  it("不提供上传、更换或单独删除图片操作", async () => {
    renderDialog()
    await screen.findByRole("img", {
      name: `待审核建议图片：${item.title}`,
    })

    expect(screen.queryByLabelText("附加图片（可选）")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "更换图片" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /删除图片|移除图片/ })
    ).not.toBeInTheDocument()
  })

  it("切换条目时忽略先返回的旧预览", async () => {
    const firstRequest = deferredValue<typeof preview | null>()
    const secondPreview = {
      ...preview,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      signedUrl: "https://storage.example.test/second-private-preview",
    }
    vi.mocked(getAdminRoadmapItemImage)
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(secondPreview)
    const secondItem = {
      ...item,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      title: "第二条建议",
    }
    const view = renderDialog()

    view.rerender(
      <ItemDialog
        item={secondItem}
        projectId={item.projectId}
        nextSortOrder={1}
        onOpenChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(
      await screen.findByRole("img", {
        name: `待审核建议图片：${secondItem.title}`,
      })
    ).toHaveAttribute("src", secondPreview.signedUrl)

    await act(async () => firstRequest.resolve(preview))

    expect(
      screen.getByRole("img", {
        name: `待审核建议图片：${secondItem.title}`,
      })
    ).toHaveAttribute("src", secondPreview.signedUrl)
    expect(
      screen.queryByRole("img", { name: new RegExp(item.title) })
    ).toBeNull()
  })

  it("关闭后忽略仍在进行的预览响应", async () => {
    const request = deferredValue<typeof preview | null>()
    const onOpenChange = vi.fn()
    vi.mocked(getAdminRoadmapItemImage).mockReturnValue(request.promise)
    renderDialog({ onOpenChange })

    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await act(async () => request.resolve(preview))

    await waitFor(() => {
      expect(
        screen.queryByRole("img", {
          name: `待审核建议图片：${item.title}`,
        })
      ).not.toBeInTheDocument()
    })
  })
})
