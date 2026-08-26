import { beforeEach, describe, expect, it, vi } from "vitest"

const { getSupabaseBrowserClient, getSupabasePublicConfig } = vi.hoisted(
  () => ({
    getSupabaseBrowserClient: vi.fn(),
    getSupabasePublicConfig: vi.fn(),
  })
)

vi.mock("@/lib/supabase/browser", () => ({
  getSupabaseBrowserClient,
  getSupabasePublicConfig,
}))

import {
  mapProjectRow,
  mapRoadmapItemRow,
  mapRoadmapStatusHistoryRow,
  submitSuggestion,
  voteForItem,
} from "@/features/roadmap/api"

beforeEach(() => {
  getSupabaseBrowserClient.mockReset()
  getSupabasePublicConfig.mockReset()
  getSupabasePublicConfig.mockReturnValue({
    url: "https://example.supabase.co",
    publishableKey: "public-key",
  })
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ itemId: "item-1" }),
    })
  )
})

describe("Roadmap API mapping", () => {
  const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

  it("maps database project fields into the UI model", () => {
    expect(
      mapProjectRow({
        id: "project-1",
        name: "广告系统",
        slug: "advertising-system",
        project_url: "https://ads.example.test",
        sort_order: 2,
      })
    ).toEqual({
      id: "project-1",
      name: "广告系统",
      slug: "advertising-system",
      projectUrl: "https://ads.example.test",
      sortOrder: 2,
    })
  })

  it("converts bigint vote counts to a safe display number", () => {
    expect(
      mapRoadmapItemRow({
        id: "item-1",
        project_id: "project-1",
        title: "导出报表",
        description: "支持 CSV",
        status: "approved",
        sort_order: 1,
        vote_count: "42",
        has_image: true,
        image_id: imageId,
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      })
    ).toMatchObject({ voteCount: 42, hasImage: true, imageId })
  })

  it("maps a pending image without exposing its identifier", () => {
    expect(
      mapRoadmapItemRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "告警截图",
        description: "复现信息",
        status: "pending",
        sort_order: 0,
        vote_count: 0,
        has_image: true,
        image_id: null,
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      })
    ).toMatchObject({ hasImage: true, imageId: null })
  })

  it.each([
    { has_image: "true", image_id: null, status: "approved" },
    { has_image: true, image_id: "not-a-uuid", status: "approved" },
    { has_image: true, image_id: imageId, status: "pending" },
    { has_image: true, image_id: imageId, status: "rejected" },
  ])("refuses invalid public image metadata %#", (imageFields) => {
    expect(() =>
      mapRoadmapItemRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "告警截图",
        description: "复现信息",
        sort_order: 0,
        vote_count: 0,
        ...imageFields,
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      })
    ).toThrow("Roadmap 图片元数据无效")
  })

  it("refuses unknown database statuses", () => {
    expect(() =>
      mapRoadmapItemRow({
        id: "item-1",
        project_id: "project-1",
        title: "导出报表",
        description: "",
        status: "archived",
        sort_order: 1,
        vote_count: 0,
        has_image: false,
        image_id: null,
        created_at: "2026-08-24T08:00:00.000Z",
        updated_at: "2026-08-24T09:00:00.000Z",
      })
    ).toThrow("Roadmap 状态无效")
  })

  it("maps a status history row into the UI model", () => {
    expect(
      mapRoadmapStatusHistoryRow({
        id: 7,
        roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        from_status: "approved",
        to_status: "in_progress",
        changed_at: "2026-08-24T16:30:00.000Z",
      })
    ).toEqual({
      id: 7,
      roadmapItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fromStatus: "approved",
      toStatus: "in_progress",
      changedAt: "2026-08-24T16:30:00.000Z",
    })
  })

  it("refuses unknown database statuses in history", () => {
    expect(() =>
      mapRoadmapStatusHistoryRow({
        id: 8,
        roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        from_status: "approved",
        to_status: "archived",
        changed_at: "2026-08-24T16:30:00.000Z",
      })
    ).toThrow("Roadmap 状态历史无效")
  })
})

describe("Roadmap public function requests", () => {
  it("submits suggestion text and image as browser-generated multipart data", async () => {
    const image = new File([new Uint8Array([1, 2, 3])], "proof.png", {
      type: "image/png",
    })

    await submitSuggestion({
      projectId: "project-1",
      title: "增加通知",
      description: "支持邮件通知",
      image,
    })

    expect(fetch).toHaveBeenCalledWith(
      "https://example.supabase.co/functions/v1/submit-suggestion",
      expect.objectContaining({
        method: "POST",
        headers: { apikey: "public-key" },
        body: expect.any(FormData),
      })
    )

    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(FormData)
    const formData = body as FormData
    expect(Array.from(formData.keys())).toEqual([
      "projectId",
      "title",
      "description",
      "image",
    ])
    expect(formData.get("projectId")).toBe("project-1")
    expect(formData.get("title")).toBe("增加通知")
    expect(formData.get("description")).toBe("支持邮件通知")
    const submittedImage = formData.get("image")
    expect(submittedImage).toBeInstanceOf(File)
    expect(submittedImage).toMatchObject({
      name: "proof.png",
      size: 3,
      type: "image/png",
    })
    expect(
      new Uint8Array(await (submittedImage as File).arrayBuffer())
    ).toEqual(new Uint8Array(await image.arrayBuffer()))
  })

  it("omits the image field when a suggestion has no image", async () => {
    await submitSuggestion({
      projectId: "project-1",
      title: "增加通知",
      description: "",
      image: null,
    })

    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body as FormData
    expect(Array.from(body.entries())).toEqual([
      ["projectId", "project-1"],
      ["title", "增加通知"],
      ["description", ""],
    ])
  })

  it("keeps vote requests as JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ voteCount: 4, duplicate: false }),
    } as never)

    await voteForItem("item-1")

    expect(fetch).toHaveBeenCalledWith(
      "https://example.supabase.co/functions/v1/vote",
      {
        method: "POST",
        headers: {
          apikey: "public-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roadmapItemId: "item-1" }),
      }
    )
  })
})
