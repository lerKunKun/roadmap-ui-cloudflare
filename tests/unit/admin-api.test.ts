import { beforeEach, describe, expect, it, vi } from "vitest"

const { getSupabaseBrowserClient } = vi.hoisted(() => ({
  getSupabaseBrowserClient: vi.fn(),
}))

vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient }))

import {
  createProject,
  deleteProject,
  moveRoadmapItem,
} from "@/features/roadmap/admin-api"
import {
  isAdminSession,
  signInAdmin,
} from "@/features/admin/use-admin-session"

describe("admin Roadmap API", () => {
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
