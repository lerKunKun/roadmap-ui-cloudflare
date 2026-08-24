import { expect, test, type Page, type Route } from "@playwright/test"

const PROJECT_ID = "11111111-1111-4111-8111-111111111111"
const CREATED_PROJECT_ID = "33333333-3333-4333-8333-333333333333"
const CREATED_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const timestamp = "2026-08-24T08:00:00.000Z"

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
  aud: "authenticated",
  exp: 1983812996,
  sub: "99999999-9999-4999-8999-999999999999",
  email: "roadmap-admin@internal.invalid",
  role: "authenticated",
})}.fixture-signature`

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

async function installAdminApi(page: Page) {
  const projects = [
    { id: PROJECT_ID, name: "广告系统", slug: "advertising-system", project_url: null, sort_order: 0 },
  ]
  const items: Array<Record<string, unknown>> = []

  await page.route("https://e2e.supabase.co/auth/v1/token**", async (route) => {
    const body = route.request().postDataJSON() as { password: string }
    if (body.password !== "Correct-admin-password-2026!") {
      await json(route, { error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400)
      return
    }
    await json(route, {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: 1983812996,
      refresh_token: "fixture-refresh-token",
      user: {
        id: "99999999-9999-4999-8999-999999999999",
        aud: "authenticated",
        role: "authenticated",
        email: "roadmap-admin@internal.invalid",
        email_confirmed_at: timestamp,
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
        identities: [],
        created_at: timestamp,
        updated_at: timestamp,
        is_anonymous: false,
      },
    })
  })
  await page.route("https://e2e.supabase.co/auth/v1/logout**", (route) => route.fulfill({ status: 204 }))

  await page.route("https://e2e.supabase.co/rest/v1/projects**", async (route) => {
    const method = route.request().method()
    if (method === "GET") return json(route, projects)
    if (method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      const created = { id: CREATED_PROJECT_ID, ...payload }
      projects.push(created as (typeof projects)[number])
      return json(route, created, 201)
    }
    const id = new URL(route.request().url()).searchParams.get("id")?.replace("eq.", "")
    if (method === "DELETE") {
      if (items.some((entry) => entry.project_id === id)) {
        return json(route, { code: "23503", message: "foreign key violation" }, 409)
      }
      const index = projects.findIndex((project) => project.id === id)
      if (index >= 0) projects.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    return json(route, {})
  })

  await page.route("https://e2e.supabase.co/rest/v1/roadmap_items_public**", async (route) => {
    const projectId = new URL(route.request().url()).searchParams.get("project_id")?.replace("eq.", "")
    await json(route, items.filter((entry) => entry.project_id === projectId).map((entry) => ({ ...entry, vote_count: 0 })))
  })

  await page.route("https://e2e.supabase.co/rest/v1/rpc/move_roadmap_item", async (route) => {
    const payload = route.request().postDataJSON() as {
      target_item_id: string
      target_status: string
      target_sort_order: number
    }
    const entry = items.find((candidate) => candidate.id === payload.target_item_id)!
    Object.assign(entry, {
      status: payload.target_status,
      sort_order: payload.target_sort_order,
      updated_at: timestamp,
    })
    await json(route, null)
  })
  await page.route("https://e2e.supabase.co/rest/v1/rpc/move_project", async (route) => {
    const payload = route.request().postDataJSON() as {
      target_project_id: string
      target_sort_order: number
    }
    const project = projects.find((candidate) => candidate.id === payload.target_project_id)!
    project.sort_order = payload.target_sort_order
    await json(route, payload.target_sort_order)
  })

  await page.route(/^https:\/\/e2e\.supabase\.co\/rest\/v1\/roadmap_items(?:\?|$)/, async (route) => {
    const method = route.request().method()
    const id = new URL(route.request().url()).searchParams.get("id")?.replace("eq.", "")
    if (method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      const created = { id: CREATED_ITEM_ID, ...payload, created_at: timestamp, updated_at: timestamp }
      items.push(created)
      return json(route, created, 201)
    }
    if (method === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>
      const entry = items.find((candidate) => candidate.id === id)!
      Object.assign(entry, payload, { updated_at: timestamp })
      const wantsRepresentation = route.request().headers()["prefer"]?.includes("return=representation")
      return wantsRepresentation ? json(route, entry) : route.fulfill({ status: 204 })
    }
    if (method === "DELETE") {
      const index = items.findIndex((entry) => entry.id === id)
      if (index >= 0) items.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    return json(route, [])
  })
}

test("管理端仅需密码并完成项目与条目 CRUD", async ({ page }) => {
  await installAdminApi(page)
  await page.goto("/admin/")

  await expect(page.getByLabel("管理密码")).toHaveAttribute("type", "password")
  await expect(page.getByLabel(/邮箱/)).toHaveCount(0)

  await page.getByLabel("管理密码").fill("wrong-password")
  await page.getByRole("button", { name: "进入管理端" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "密码不正确" })).toBeVisible()

  await page.getByLabel("管理密码").fill("Correct-admin-password-2026!")
  await page.getByRole("button", { name: "进入管理端" }).click()
  await expect(page.getByRole("heading", { name: "路线图管理" })).toBeVisible()

  await page.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByLabel("项目名称").fill("模板工具")
  await page.getByLabel("项目标识").fill("template-tools")
  await page.getByLabel("项目网址").fill("templates.example.test")
  await page.getByRole("button", { name: "保存项目" }).click()
  await expect(page.getByLabel("切换项目")).toHaveValue(CREATED_PROJECT_ID)

  await page.getByRole("button", { name: "Roadmap 条目" }).click()
  await page.getByLabel("标题").fill("批量生成模板")
  await page.getByLabel("详细说明").fill("支持批量数据导入")
  await page.getByRole("button", { name: "保存条目" }).click()
  await expect(page.getByRole("heading", { name: "批量生成模板" })).toBeVisible()

  await page.getByLabel("调整“批量生成模板”阶段").selectOption("in_progress")
  await expect(page.getByRole("region", { name: "进行中" }).getByRole("heading", { name: "批量生成模板" })).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "删除当前项目" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "请先删除或移动" })).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "删除“批量生成模板”" }).click()
  await expect(page.getByRole("heading", { name: "批量生成模板" })).toHaveCount(0)

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "删除当前项目" }).click()
  await expect(page.getByLabel("切换项目")).toHaveValue(PROJECT_ID)

  await page.getByRole("button", { name: "退出管理端" }).click()
  await expect(page.getByRole("heading", { name: "管理端登录" })).toBeVisible()
})
