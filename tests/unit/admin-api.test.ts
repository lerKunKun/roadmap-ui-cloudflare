import { beforeEach, describe, expect, it, vi } from "vitest"

const { getSupabaseBrowserClient } = vi.hoisted(() => ({
  getSupabaseBrowserClient: vi.fn(),
}))

vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient }))

import {
  createProject,
  createRoadmapItem,
  deleteProject,
  deleteRoadmapItem,
  getAdminRoadmapItemImage,
  moveRoadmapItem,
  updateRoadmapItem,
} from "@/features/roadmap/admin-api"
import {
  isAdminSession,
  signInAdmin,
} from "@/features/admin/use-admin-session"

describe("admin Roadmap API", () => {
  const itemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const projectId = "11111111-1111-4111-8111-111111111111"
  const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const itemRow = {
    id: itemId,
    project_id: projectId,
    title: "告警截图",
    description: "复现信息",
    status: "approved",
    sort_order: 0,
    created_at: "2026-08-24T08:00:00.000Z",
    updated_at: "2026-08-24T09:00:00.000Z",
  }

  beforeEach(() => {
    getSupabaseBrowserClient.mockReset()
  })

  it("规范化项目网址并发送 snake_case 字段", async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        id: "project-1",
        name: "广告系统",
        slug: "advertising-system",
        project_url: "https://ads.example.com/",
        sort_order: 0,
      },
      error: null,
    })
    const select = vi.fn(() => ({ single }))
    const insert = vi.fn(() => ({ select }))
    const rpc = vi.fn().mockResolvedValue({ data: 0, error: null })
    getSupabaseBrowserClient.mockReturnValue({
      from: vi.fn(() => ({ insert })),
      rpc,
    })

    const project = await createProject({
      name: " 广告系统 ",
      slug: "advertising-system",
      projectUrl: "ads.example.com",
      sortOrder: 0,
    })

    expect(insert).toHaveBeenCalledWith({
      name: "广告系统",
      slug: "advertising-system",
      project_url: "https://ads.example.com/",
      sort_order: 0,
    })
    expect(project.projectUrl).toBe("https://ads.example.com/")
    expect(rpc).toHaveBeenCalledWith("move_project", {
      target_project_id: "project-1",
      target_sort_order: 0,
    })
  })

  it("拒绝未知状态，不向数据库发送请求", async () => {
    const from = vi.fn()
    const rpc = vi.fn()
    getSupabaseBrowserClient.mockReturnValue({ from, rpc })

    await expect(
      moveRoadmapItem("item-1", "archived" as never, 0),
    ).rejects.toThrow("Roadmap 状态无效")
    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it("通过数据库函数原子移动并重排条目", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    getSupabaseBrowserClient.mockReturnValue({ rpc })

    await moveRoadmapItem("item-1", "in_progress", 2)

    expect(rpc).toHaveBeenCalledWith("move_roadmap_item", {
      target_item_id: "item-1",
      target_status: "in_progress",
      target_sort_order: 2,
    })
  })

  it("创建条目后从认证元数据补全已有公开图片", async () => {
    const itemSingle = vi.fn().mockResolvedValue({ data: itemRow, error: null })
    const itemSelect = vi.fn(() => ({ single: itemSingle }))
    const insert = vi.fn(() => ({ select: itemSelect }))
    const metadataMaybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: `suggestions/${itemId}/${imageId}.png`,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const metadataEq = vi.fn(() => ({ maybeSingle: metadataMaybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const from = vi.fn((table: string) =>
      table === "roadmap_items" ? { insert } : { select: metadataSelect }
    )
    getSupabaseBrowserClient.mockReturnValue({ from })

    const created = await createRoadmapItem({
      projectId,
      title: itemRow.title,
      description: itemRow.description,
      status: "approved",
      sortOrder: 0,
    })

    expect(from).toHaveBeenCalledWith("roadmap_item_images")
    expect(metadataEq).toHaveBeenCalledWith("roadmap_item_id", itemId)
    expect(created).toMatchObject({ hasImage: true, imageId })
  })

  it("更新为拒绝状态后保留图片存在性但不暴露图片 ID", async () => {
    const rejectedRow = { ...itemRow, status: "rejected" }
    const itemSingle = vi
      .fn()
      .mockResolvedValue({ data: rejectedRow, error: null })
    const itemSelect = vi.fn(() => ({ single: itemSingle }))
    const eqItem = vi.fn(() => ({ select: itemSelect }))
    const update = vi.fn(() => ({ eq: eqItem }))
    const metadataMaybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: `suggestions/${itemId}/${imageId}.png`,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const metadataEq = vi.fn(() => ({ maybeSingle: metadataMaybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const from = vi.fn((table: string) =>
      table === "roadmap_items" ? { update } : { select: metadataSelect }
    )
    getSupabaseBrowserClient.mockReturnValue({ from })

    const updated = await updateRoadmapItem(itemId, {
      projectId,
      title: itemRow.title,
      description: itemRow.description,
      status: "rejected",
      sortOrder: 0,
    })

    expect(updated).toMatchObject({ hasImage: true, imageId: null })
  })

  it("图片元数据不存在时不签发预览地址", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const createSignedUrl = vi.fn()
    getSupabaseBrowserClient.mockReturnValue({
      from: vi.fn(() => ({ select })),
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    })

    await expect(getAdminRoadmapItemImage(itemId)).resolves.toBeNull()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it("从私有存储桶签发 300 秒预览地址且不返回存储路径", async () => {
    const storagePath = `suggestions/${itemId}/${imageId}.png`
    const metadata = {
      id: imageId,
      roadmap_item_id: itemId,
      storage_path: storagePath,
      mime_type: "image/png",
      size_bytes: 128,
      width: 20,
      height: 10,
    }
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: metadata, error: null })
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example.test/private-preview" },
      error: null,
    })
    const storageFrom = vi.fn(() => ({ createSignedUrl }))
    getSupabaseBrowserClient.mockReturnValue({
      from: vi.fn(() => ({ select })),
      storage: { from: storageFrom },
    })

    const preview = await getAdminRoadmapItemImage(itemId)

    expect(storageFrom).toHaveBeenCalledWith("roadmap-images")
    expect(createSignedUrl).toHaveBeenCalledWith(storagePath, 300)
    expect(preview).toEqual({
      id: imageId,
      signedUrl: "https://storage.example.test/private-preview",
      mimeType: "image/png",
      sizeBytes: 128,
      width: 20,
      height: 10,
    })
    expect(preview).not.toHaveProperty("storagePath")
    expect(preview).not.toHaveProperty("storage_path")
  })

  it("把签名失败映射为不含私有路径的稳定提示", async () => {
    const storagePath = `suggestions/${itemId}/secret-name.png`
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: storagePath,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: null,
      error: { message: `cannot sign ${storagePath}` },
    })
    getSupabaseBrowserClient.mockReturnValue({
      from: vi.fn(() => ({ select })),
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    })

    const request = getAdminRoadmapItemImage(itemId)

    await expect(request).rejects.toThrow("建议图片加载失败，请重试")
    await expect(request).rejects.not.toThrow(storagePath)
  })

  it("没有图片的条目直接删除数据库记录", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const metadataEq = vi.fn(() => ({ maybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const itemEq = vi.fn().mockResolvedValue({ error: null })
    const itemDelete = vi.fn(() => ({ eq: itemEq }))
    const storageRemove = vi.fn()
    const from = vi.fn((table: string) =>
      table === "roadmap_item_images"
        ? { select: metadataSelect }
        : { delete: itemDelete }
    )
    getSupabaseBrowserClient.mockReturnValue({
      from,
      storage: { from: vi.fn(() => ({ remove: storageRemove })) },
    })

    await deleteRoadmapItem(itemId)

    expect(storageRemove).not.toHaveBeenCalled()
    expect(itemEq).toHaveBeenCalledWith("id", itemId)
  })

  it("先删除图片对象再删除条目记录", async () => {
    const events: string[] = []
    const storagePath = `suggestions/${itemId}/${imageId}.png`
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: storagePath,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const metadataEq = vi.fn(() => ({ maybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const itemEq = vi.fn().mockImplementation(async () => {
      events.push("item-row")
      return { error: null }
    })
    const itemDelete = vi.fn(() => ({ eq: itemEq }))
    const storageRemove = vi.fn().mockImplementation(async () => {
      events.push("storage-object")
      return { data: [], error: null }
    })
    const from = vi.fn((table: string) =>
      table === "roadmap_item_images"
        ? { select: metadataSelect }
        : { delete: itemDelete }
    )
    const storageFrom = vi.fn(() => ({ remove: storageRemove }))
    getSupabaseBrowserClient.mockReturnValue({
      from,
      storage: { from: storageFrom },
    })

    await deleteRoadmapItem(itemId)

    expect(storageFrom).toHaveBeenCalledWith("roadmap-images")
    expect(storageRemove).toHaveBeenCalledWith([storagePath])
    expect(events).toEqual(["storage-object", "item-row"])
  })

  it("图片对象明确不存在时仍删除条目记录", async () => {
    const storagePath = `suggestions/${itemId}/${imageId}.png`
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: storagePath,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const metadataEq = vi.fn(() => ({ maybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const itemEq = vi.fn().mockResolvedValue({ error: null })
    const itemDelete = vi.fn(() => ({ eq: itemEq }))
    const storageRemove = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "NoSuchKey",
        status: 404,
        statusCode: "404",
        message: "The resource was not found",
      },
    })
    const from = vi.fn((table: string) =>
      table === "roadmap_item_images"
        ? { select: metadataSelect }
        : { delete: itemDelete }
    )
    getSupabaseBrowserClient.mockReturnValue({
      from,
      storage: { from: vi.fn(() => ({ remove: storageRemove })) },
    })

    await deleteRoadmapItem(itemId)

    expect(storageRemove).toHaveBeenCalledWith([storagePath])
    expect(itemEq).toHaveBeenCalledWith("id", itemId)
  })

  it.each([
    { code: "NoSuchBucket", status: 404, statusCode: "404" },
    { code: "TenantNotFound", status: 404, statusCode: "404" },
    { code: "not_found", status: 404, statusCode: "404" },
    { status: 404, statusCode: "404" },
    { code: "AccessDenied", status: 403, statusCode: "403" },
  ])("图片删除失败 %o 时保留条目记录", async (storageError) => {
    const storagePath = `suggestions/${itemId}/${imageId}.png`
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: imageId,
        roadmap_item_id: itemId,
        storage_path: storagePath,
        mime_type: "image/png",
        size_bytes: 128,
        width: 20,
        height: 10,
      },
      error: null,
    })
    const metadataEq = vi.fn(() => ({ maybeSingle }))
    const metadataSelect = vi.fn(() => ({ eq: metadataEq }))
    const itemDelete = vi.fn()
    const storageRemove = vi.fn().mockResolvedValue({
      data: null,
      error: { ...storageError, message: "Storage failure" },
    })
    const from = vi.fn((table: string) =>
      table === "roadmap_item_images"
        ? { select: metadataSelect }
        : { delete: itemDelete }
    )
    getSupabaseBrowserClient.mockReturnValue({
      from,
      storage: { from: vi.fn(() => ({ remove: storageRemove })) },
    })

    await expect(deleteRoadmapItem(itemId)).rejects.toThrow(
      "建议图片删除失败，Roadmap 条目已保留"
    )
    expect(itemDelete).not.toHaveBeenCalled()
  })

  it("把有关联条目的项目删除错误翻译成可操作提示", async () => {
    const eq = vi.fn().mockResolvedValue({
      error: { code: "23503", message: "foreign key violation" },
    })
    const remove = vi.fn(() => ({ eq }))
    getSupabaseBrowserClient.mockReturnValue({
      from: vi.fn(() => ({ delete: remove })),
    })

    await expect(deleteProject("project-1")).rejects.toThrow(
      "请先删除或移动该项目中的 Roadmap 条目",
    )
  })

  it("使用固定邮箱和用户输入的密码登录", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { session: null },
      error: null,
    })
    getSupabaseBrowserClient.mockReturnValue({
      auth: { signInWithPassword },
    })

    await signInAdmin("Strong-password-2026!")

    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "roadmap-admin@internal.invalid",
      password: "Strong-password-2026!",
    })
  })

  it("把无效凭据翻译为密码错误", async () => {
    getSupabaseBrowserClient.mockReturnValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          error: { message: "Invalid login credentials" },
        }),
      },
    })

    await expect(signInAdmin("wrong-password")).rejects.toThrow("密码不正确")
  })

  it("只把固定邮箱的会话识别为管理员", () => {
    expect(
      isAdminSession({ user: { email: "roadmap-admin@internal.invalid" } }),
    ).toBe(true)
    expect(isAdminSession({ user: { email: "viewer@example.com" } })).toBe(false)
    expect(isAdminSession(null)).toBe(false)
  })
})
