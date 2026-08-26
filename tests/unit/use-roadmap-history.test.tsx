import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { listRoadmapStatusHistory } from "@/features/roadmap/api"
import { useRoadmapHistory } from "@/features/roadmap/use-roadmap-history"
import type { RoadmapStatusHistoryEntry } from "@/features/roadmap/types"

vi.mock("@/features/roadmap/api", () => ({
  listRoadmapStatusHistory: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const historyA: RoadmapStatusHistoryEntry = {
  id: 1,
  roadmapItemId: "item-a",
  fromStatus: null,
  toStatus: "pending",
  changedAt: "2026-08-24T08:00:00.000Z",
}

const historyB: RoadmapStatusHistoryEntry = {
  id: 2,
  roadmapItemId: "item-b",
  fromStatus: "pending",
  toStatus: "approved",
  changedAt: "2026-08-25T08:00:00.000Z",
}

describe("useRoadmapHistory", () => {
  beforeEach(() => {
    vi.mocked(listRoadmapStatusHistory).mockReset()
  })

  it("keeps the latest item when an earlier request resolves last", async () => {
    const first = deferred<RoadmapStatusHistoryEntry[]>()
    const second = deferred<RoadmapStatusHistoryEntry[]>()
    vi.mocked(listRoadmapStatusHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const { result, rerender } = renderHook(
      ({ itemId }) => useRoadmapHistory(itemId),
      { initialProps: { itemId: "item-a" as string | null } }
    )

    rerender({ itemId: "item-b" })
    await act(async () => second.resolve([historyB]))
    await waitFor(() => expect(result.current.entries).toEqual([historyB]))

    await act(async () => first.resolve([historyA]))
    expect(result.current.entries).toEqual([historyB])
  })

  it("clears loaded history when the detail closes", async () => {
    vi.mocked(listRoadmapStatusHistory).mockResolvedValue([historyA])
    const { result, rerender } = renderHook(
      ({ itemId }) => useRoadmapHistory(itemId),
      { initialProps: { itemId: "item-a" as string | null } }
    )

    await waitFor(() => expect(result.current.entries).toEqual([historyA]))
    rerender({ itemId: null })

    expect(result.current).toMatchObject({
      entries: [],
      loading: false,
      error: null,
    })
  })

  it("retries the current item after a failed request", async () => {
    vi.mocked(listRoadmapStatusHistory)
      .mockRejectedValueOnce(new Error("时间轴网络异常"))
      .mockResolvedValueOnce([historyA])
    const { result } = renderHook(() => useRoadmapHistory("item-a"))

    await waitFor(() => expect(result.current.error).toBe("时间轴网络异常"))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.entries).toEqual([historyA]))

    expect(listRoadmapStatusHistory).toHaveBeenNthCalledWith(1, "item-a")
    expect(listRoadmapStatusHistory).toHaveBeenNthCalledWith(2, "item-a")
  })
})
