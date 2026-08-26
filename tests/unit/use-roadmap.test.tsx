import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  listProjects,
  listRoadmapItems,
  submitSuggestion,
  voteForItem,
} from "@/features/roadmap/api"
import { useRoadmap } from "@/features/roadmap/use-roadmap"
import type { Project, RoadmapItem } from "@/features/roadmap/types"

vi.mock("@/features/roadmap/api", () => ({
  listProjects: vi.fn(),
  listRoadmapItems: vi.fn(),
  submitSuggestion: vi.fn(),
  voteForItem: vi.fn(),
}))

const project: Project = {
  id: "project-1",
  name: "广告系统",
  slug: "advertising-system",
  projectUrl: null,
  sortOrder: 0,
}

const item: RoadmapItem = {
  id: "item-1",
  projectId: project.id,
  title: "导出报表",
  description: "支持 CSV",
  status: "pending",
  sortOrder: 0,
  voteCount: 3,
  hasImage: false,
  imageId: null,
  createdAt: "2026-08-24T08:00:00.000Z",
  updatedAt: "2026-08-24T08:00:00.000Z",
}

describe("useRoadmap", () => {
  beforeEach(() => {
    vi.mocked(listProjects).mockResolvedValue([project])
    vi.mocked(listRoadmapItems).mockResolvedValue([item])
  })

  it("selects the first project and loads only its roadmap", async () => {
    const { result } = renderHook(() => useRoadmap())

    await waitFor(() => expect(result.current.items).toEqual([item]))

    expect(result.current.selectedProject?.id).toBe(project.id)
    expect(listRoadmapItems).toHaveBeenCalledWith(project.id)
  })

  it("updates the visible count after a successful vote", async () => {
    vi.mocked(voteForItem).mockResolvedValue({
      voteCount: 4,
      duplicate: false,
    })
    const { result } = renderHook(() => useRoadmap())
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(() => result.current.vote("item-1"))

    expect(result.current.items[0].voteCount).toBe(4)
    expect(result.current.notice).toBe("投票成功，感谢你的反馈")
  })

  it("explains duplicate votes without inflating the count", async () => {
    vi.mocked(voteForItem).mockResolvedValue({
      voteCount: 3,
      duplicate: true,
    })
    const { result } = renderHook(() => useRoadmap())
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await act(() => result.current.vote("item-1"))

    expect(result.current.items[0].voteCount).toBe(3)
    expect(result.current.notice).toBe("当前网络已投过票")
  })

  it("does not report a successful suggestion as failed when refresh fails", async () => {
    vi.mocked(submitSuggestion).mockResolvedValue({ itemId: "item-2" })
    vi.mocked(listRoadmapItems)
      .mockResolvedValueOnce([item])
      .mockRejectedValueOnce(new Error("列表刷新失败"))
    const { result } = renderHook(() => useRoadmap())
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    await expect(
      act(() =>
        result.current.submit({
          projectId: project.id,
          title: "增加通知",
          description: "支持邮件通知",
          image: null,
        })
      )
    ).resolves.toBeUndefined()

    expect(result.current.notice).toBe("建议已提交，但列表刷新失败")
  })

  it("retries the project list after the initial request fails", async () => {
    vi.mocked(listProjects)
      .mockRejectedValueOnce(new Error("项目列表加载失败"))
      .mockResolvedValueOnce([project])
    const { result } = renderHook(() => useRoadmap())

    await waitFor(() => expect(result.current.error).toBe("项目列表加载失败"))
    await act(() => result.current.reload())
    await waitFor(() =>
      expect(result.current.selectedProject?.id).toBe(project.id)
    )

    expect(listProjects).toHaveBeenCalledTimes(2)
  })
})
