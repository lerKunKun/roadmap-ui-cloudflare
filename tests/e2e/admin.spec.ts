import { expect, test, type Page, type Route } from "@playwright/test"

const PROJECT_ID = "11111111-1111-4111-8111-111111111111"
const CREATED_PROJECT_ID = "33333333-3333-4333-8333-333333333333"
const CREATED_ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const IMAGE_ITEM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const IMAGE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const IMAGE_STORAGE_PATH = `suggestions/${IMAGE_ITEM_ID}/${IMAGE_ID}.png`
const SIGNED_IMAGE_PATH = `/object/sign/roadmap-images/${IMAGE_STORAGE_PATH}?token=e2e-preview-token`
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgaPj/H4xhDABS0gn50Ke7SAAAAABJRU5ErkJggg==",
  "base64"
)
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

async function installAdminApi(
  page: Page,
  options: { imageItem?: boolean; storageDeleteFails?: boolean } = {}
) {
  const projects = [
    { id: PROJECT_ID, name: "广告系统", slug: "advertising-system", project_url: null, sort_order: 0 },
  ]
  const items: Array<Record<string, unknown>> = options.imageItem
    ? [
        {
          id: IMAGE_ITEM_ID,
          project_id: PROJECT_ID,
          title: "待审核截图建议",
          description: "管理员需要查看签名预览后再调整阶段",
          status: "pending",
          sort_order: 0,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ]
    : []
  const events: string[] = []
  const imageMetadata = options.imageItem
    ? {
        id: IMAGE_ID,
        roadmap_item_id: IMAGE_ITEM_ID,
        storage_path: IMAGE_STORAGE_PATH,
        mime_type: "image/png",
        size_bytes: PNG_BYTES.length,
        width: 2,
        height: 2,
      }
    : null

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
    if (method === "GET") {
      return json(route, [...projects].sort((a, b) => a.sort_order - b.sort_order))
    }
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
    await json(route, items.filter((entry) => entry.project_id === projectId).map((entry) => ({
      ...entry,
      vote_count: 0,
      has_image: imageMetadata?.roadmap_item_id === entry.id,
      image_id:
        imageMetadata &&
        imageMetadata.roadmap_item_id === entry.id &&
        entry.status !== "pending" &&
        entry.status !== "rejected"
          ? imageMetadata.id
          : null,
    })))
  })

  await page.route("https://e2e.supabase.co/rest/v1/roadmap_item_images**", async (route) => {
    const itemId = new URL(route.request().url()).searchParams
      .get("roadmap_item_id")
      ?.replace("eq.", "")
    await json(
      route,
      imageMetadata && imageMetadata.roadmap_item_id === itemId
        ? [imageMetadata]
        : []
    )
  })

  await page.route(
    "https://e2e.supabase.co/storage/v1/object/sign/roadmap-images/**",
    async (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ expiresIn: 300 })
        await json(route, { signedURL: SIGNED_IMAGE_PATH })
        return
      }
      await route.fulfill({ contentType: "image/png", body: PNG_BYTES })
    }
  )

  await page.route(
    "https://e2e.supabase.co/storage/v1/object/roadmap-images",
    async (route) => {
      expect(route.request().method()).toBe("DELETE")
      expect(route.request().postDataJSON()).toEqual({
        prefixes: [IMAGE_STORAGE_PATH],
      })
      events.push("storage-delete")
      if (options.storageDeleteFails) {
        await json(
          route,
          { code: "AccessDenied", message: "fixture storage failure" },
          500
        )
        return
      }
      await json(route, [])
    }
  )

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
    const target = projects.find((candidate) => candidate.id === payload.target_project_id)!
    const ordered = projects
      .filter((candidate) => candidate.id !== payload.target_project_id)
      .sort((a, b) => a.sort_order - b.sort_order)
    const finalOrder = Math.min(payload.target_sort_order, ordered.length)
    ordered.splice(finalOrder, 0, target)
    ordered.forEach((project, index) => { project.sort_order = index })
    await json(route, finalOrder)
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
      events.push("item-delete")
      const index = items.findIndex((entry) => entry.id === id)
      if (index >= 0) items.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    return json(route, [])
  })

  return { events }
}

async function login(page: Page) {
  await page.goto("/admin/")
  await page.getByLabel("管理密码").fill("Correct-admin-password-2026!")
  await page.getByRole("button", { name: "进入管理端" }).click()
  await expect(page.getByRole("heading", { name: "路线图管理" })).toBeVisible()
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
  await page.getByLabel("项目排序").fill("0")
  await page.getByRole("button", { name: "保存项目" }).click()
  await expect(page.getByLabel("切换项目")).toHaveValue(CREATED_PROJECT_ID)
  await expect(page.getByLabel("切换项目").locator("option").first()).toHaveText("模板工具")

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

test("管理端签名预览不阻塞阶段调整且先删 Storage 再删条目", async ({
  page,
}) => {
  const fixture = await installAdminApi(page, { imageItem: true })
  await page.emulateMedia({ colorScheme: "dark" })
  const shortMobileViewport = { width: 390, height: 568 }
  await page.setViewportSize(shortMobileViewport)
  await login(page)

  await page.getByRole("button", { name: "编辑“待审核截图建议”" }).click()
  const dialog = page.getByRole("dialog")
  const preview = dialog.getByRole("img", {
    name: "待审核建议图片：待审核截图建议",
  })
  await expect(preview).toBeVisible()

  const imageTrigger = dialog.getByRole("button", {
    name: "查看“待审核截图建议”大图",
  })
  await imageTrigger.click()
  const lightbox = page.getByRole("dialog", { name: "待审核截图建议 大图" })
  await expect(
    lightbox.getByRole("img", {
      name: "待审核建议图片：待审核截图建议（大图）",
    })
  ).toBeVisible()
  const lightboxMetrics = await lightbox.evaluate((element) =>
    element.getBoundingClientRect().toJSON()
  )
  expect(lightboxMetrics.top).toBeGreaterThanOrEqual(16)
  expect(lightboxMetrics.bottom).toBeLessThanOrEqual(
    shortMobileViewport.height - 16
  )
  await lightbox.getByRole("button", { name: "关闭大图" }).click()
  await expect(imageTrigger).toBeFocused()

  const dialogMetrics = await dialog.evaluate((element) => ({
    ...element.getBoundingClientRect().toJSON(),
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(dialogMetrics.top).toBeGreaterThanOrEqual(16)
  expect(dialogMetrics.bottom).toBeLessThanOrEqual(
    shortMobileViewport.height - 16
  )
  expect(dialogMetrics.height).toBeLessThanOrEqual(
    shortMobileViewport.height - 32
  )
  expect(dialogMetrics.scrollHeight).toBeGreaterThan(dialogMetrics.clientHeight)
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth)
  const dialogBackground = await dialog.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  expect(dialogBackground).not.toBe("rgba(0, 0, 0, 0)")

  const closeButton = dialog.getByRole("button", { name: "关闭" })
  const saveButton = dialog.getByRole("button", { name: "保存条目" })
  await saveButton.scrollIntoViewIfNeeded()
  await expect(saveButton).toBeInViewport()
  await closeButton.scrollIntoViewIfNeeded()
  await expect(closeButton).toBeInViewport()

  await dialog.getByLabel("当前阶段").selectOption("approved")
  await saveButton.scrollIntoViewIfNeeded()
  await saveButton.click()
  await expect(
    page
      .getByRole("region", { name: "已批准" })
      .getByRole("heading", { name: "待审核截图建议" })
  ).toBeVisible()

  page.once("dialog", (confirmation) => confirmation.accept())
  await page.getByRole("button", { name: "删除“待审核截图建议”" }).click()
  await expect(
    page.getByRole("heading", { name: "待审核截图建议" })
  ).toHaveCount(0)
  expect(fixture.events).toEqual(["storage-delete", "item-delete"])
})

test("Storage 删除失败时保留含图条目并显示稳定提示", async ({ page }) => {
  const fixture = await installAdminApi(page, {
    imageItem: true,
    storageDeleteFails: true,
  })
  await login(page)

  page.once("dialog", (confirmation) => confirmation.accept())
  await page.getByRole("button", { name: "删除“待审核截图建议”" }).click()
  await expect(
    page.getByRole("alert").filter({
      hasText: "建议图片删除失败，Roadmap 条目已保留",
    })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "待审核截图建议" })
  ).toBeVisible()
  expect(fixture.events).toEqual(["storage-delete"])
})
