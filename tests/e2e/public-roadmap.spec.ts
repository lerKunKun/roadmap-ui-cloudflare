import { expect, test, type Page } from "@playwright/test"

const PROJECT_ADS = "11111111-1111-4111-8111-111111111111"
const PROJECT_ALERT = "22222222-2222-4222-8222-222222222222"
const ITEM_ALERT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUGGESTION_ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SUGGESTION_IMAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgaPj/H4xhDABS0gn50Ke7SAAAAABJRU5ErkJggg==",
  "base64"
)

const projects = [
  {
    id: PROJECT_ADS,
    name: "广告系统",
    slug: "advertising-system",
    project_url: "https://ads.example.test/",
    sort_order: 0,
  },
  {
    id: PROJECT_ALERT,
    name: "ks-alert",
    slug: "ks-alert",
    project_url: null,
    sort_order: 1,
  },
]

function item(id: string, projectId: string, title: string, voteCount = 0) {
  return {
    id,
    project_id: projectId,
    title,
    description: "用于端到端验收的真实测试条目",
    status: "pending",
    sort_order: 0,
    vote_count: voteCount,
    has_image: false,
    image_id: null as string | null,
    created_at: "2026-08-24T08:00:00.000Z",
    updated_at: "2026-08-24T08:00:00.000Z",
  }
}

async function installPublicApi(page: Page) {
  const items = [item(ITEM_ALERT, PROJECT_ALERT, "告警通知聚合")]
  let voted = false
  let historyRequests = 0
  let mediaRequests = 0
  let abortNextMedia = false
  let submissionGate: Promise<void> | null = null
  let releaseSubmission: (() => void) | null = null
  let lastSubmission: {
    projectId: string
    title: string
    description: string
    image: File | null
  } | null = null

  await page.route(
    "https://e2e.supabase.co/rest/v1/projects**",
    async (route) => {
      await route.fulfill({ json: projects })
    }
  )
  await page.route(
    "https://e2e.supabase.co/rest/v1/roadmap_items_public**",
    async (route) => {
      const projectId = new URL(route.request().url()).searchParams
        .get("project_id")
        ?.replace("eq.", "")
      await route.fulfill({
        json: items.filter((entry) => entry.project_id === projectId),
      })
    }
  )
  await page.route(
    "https://e2e.supabase.co/rest/v1/roadmap_status_history_public**",
    async (route) => {
      historyRequests += 1
      await route.fulfill({
        json: [
          {
            id: 1,
            roadmap_item_id: ITEM_ALERT,
            from_status: null,
            to_status: "pending",
            changed_at: "2026-08-24T08:00:00.000Z",
          },
          ...(historyRequests > 1
            ? [
                {
                  id: 2,
                  roadmap_item_id: ITEM_ALERT,
                  from_status: "pending",
                  to_status: "approved",
                  changed_at: "2026-08-24T16:30:00.000Z",
                },
              ]
            : []),
        ],
      })
    }
  )
  await page.route(
    "https://e2e.supabase.co/functions/v1/submit-suggestion",
    async (route) => {
      const request = route.request()
      const contentType = await request.headerValue("content-type")
      expect(contentType).toMatch(/^multipart\/form-data;\s*boundary=/)
      const requestBody = request.postDataBuffer()
      expect(requestBody).not.toBeNull()
      const formData = await new Request("https://fixture.invalid/", {
        method: "POST",
        headers: { "content-type": contentType! },
        body: new Uint8Array(requestBody!),
      }).formData()
      const projectId = formData.get("projectId")
      const title = formData.get("title")
      const description = formData.get("description")
      const image = formData.get("image")
      expect(typeof projectId).toBe("string")
      expect(typeof title).toBe("string")
      expect(typeof description).toBe("string")
      expect(image === null || typeof image !== "string").toBe(true)
      lastSubmission = {
        projectId: projectId as string,
        title: title as string,
        description: description as string,
        image: image as File | null,
      }
      items.push({
        ...item(
          SUGGESTION_ITEM,
          lastSubmission.projectId,
          lastSubmission.title
        ),
        description: lastSubmission.description,
        has_image: lastSubmission.image !== null,
      })
      if (submissionGate) await submissionGate
      await route.fulfill({ status: 201, json: { itemId: items.at(-1)!.id } })
    }
  )
  await page.route(`**/media/${SUGGESTION_IMAGE}`, async (route) => {
    mediaRequests += 1
    if (abortNextMedia) {
      abortNextMedia = false
      await route.abort("failed")
      return
    }
    await route.fulfill({
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: PNG_BYTES,
    })
  })
  await page.route(
    "https://e2e.supabase.co/functions/v1/vote",
    async (route) => {
      const target = items.find((entry) => entry.id === ITEM_ALERT)!
      if (!voted) target.vote_count += 1
      await route.fulfill({
        json: { voteCount: target.vote_count, duplicate: voted },
      })
      voted = true
    }
  )

  return {
    approveSuggestion() {
      const suggestion = items.find((entry) => entry.id === SUGGESTION_ITEM)!
      suggestion.status = "approved"
      suggestion.image_id = SUGGESTION_IMAGE
    },
    abortNextMedia() {
      abortNextMedia = true
    },
    getMediaRequestCount() {
      return mediaRequests
    },
    getLastSubmission() {
      return lastSubmission
    },
    holdNextSubmission() {
      submissionGate = new Promise<void>((resolve) => {
        releaseSubmission = resolve
      })
      return () => {
        releaseSubmission?.()
        releaseSubmission = null
        submissionGate = null
      }
    },
  }
}

test("公开端可切换项目、提交建议并按网络去重投票", async ({ page }) => {
  await installPublicApi(page)
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Roadmap 路线图" })
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "项目路线图" }).getByRole("region")
  ).toHaveCount(5)

  await page.getByLabel("切换项目").selectOption(PROJECT_ALERT)
  await expect(page.getByText("告警通知聚合", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "提交建议" }).click()
  await page.getByLabel("建议标题").fill("支持钉钉告警")
  await page.getByLabel("详细说明").fill("希望支持钉钉群机器人通知")
  await page.getByRole("button", { name: "确认提交" }).click()
  await expect(page.getByRole("status")).toContainText("建议已提交")
  await expect(page.getByText("支持钉钉告警", { exact: true })).toBeVisible()

  const vote = page.getByRole("button", { name: "为“告警通知聚合”投票" })
  await vote.click()
  await expect(page.getByRole("status")).toContainText("投票成功")
  await expect(vote).toContainText("1")
  await vote.click()
  await expect(page.getByRole("status")).toContainText("当前网络已投过票")
  await expect(vote).toContainText("1")

  await page.setViewportSize({ width: 390, height: 844 })
  const boardMetrics = await page
    .locator(".roadmap-board")
    .evaluate((board) => ({
      clientWidth: board.clientWidth,
      scrollWidth: board.scrollWidth,
    }))
  expect(boardMetrics.scrollWidth).toBeGreaterThan(boardMetrics.clientWidth)
})

test("详情弹窗按每次打开刷新状态时间轴并适配移动端", async ({ page }) => {
  await installPublicApi(page)
  await page.goto("/")
  await page.getByLabel("切换项目").selectOption(PROJECT_ALERT)

  await page.getByRole("button", { name: "查看详情" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).not.toHaveAttribute("data-slot", "sheet-content")
  await expect(
    dialog.getByRole("region", { name: "进展时间轴" })
  ).toContainText("2026-08-24")
  await expect(dialog).not.toContainText("待处理 → 已批准")

  await dialog.getByRole("button", { name: "关闭" }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "查看详情" }).click()
  await expect(dialog).toContainText("待处理 → 已批准")
  await expect(dialog).toContainText("2026-08-25")

  await page.setViewportSize({ width: 390, height: 844 })
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(
    dialogMetrics.clientWidth
  )
})

test("带图建议从本地预览、待审核提示到公开图片失败重试保持详情完整", async ({
  page,
}) => {
  const fixture = await installPublicApi(page)
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/")
  await page.getByLabel("切换项目").selectOption(PROJECT_ALERT)

  await page.getByRole("button", { name: "提交建议" }).click()
  const suggestionDialog = page.getByRole("dialog")
  const imageInput = suggestionDialog.getByLabel("附加图片（可选）")
  const selectedImage = {
    name: "alert-screenshot.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  }
  await imageInput.setInputFiles(selectedImage)
  await expect(
    suggestionDialog.getByRole("img", { name: "所选图片预览" })
  ).toBeVisible()
  await expect(suggestionDialog.getByText(selectedImage.name)).toBeVisible()
  await suggestionDialog.getByRole("button", { name: "移除图片" }).click()
  await expect(
    suggestionDialog.getByRole("img", { name: "所选图片预览" })
  ).toHaveCount(0)
  await expect(suggestionDialog.getByText(selectedImage.name)).toHaveCount(0)

  await imageInput.setInputFiles(selectedImage)
  await page.getByLabel("建议标题").fill("图片审核建议")
  await page.getByLabel("详细说明").fill("图片失败时正文、投票和时间轴都必须保留")
  await page.setViewportSize({ width: 390, height: 844 })
  const suggestionDialogMetrics = await suggestionDialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(suggestionDialogMetrics.scrollWidth).toBeLessThanOrEqual(
    suggestionDialogMetrics.clientWidth
  )

  const releaseSubmission = fixture.holdNextSubmission()
  await page.getByRole("button", { name: "确认提交" }).click()
  await expect(
    suggestionDialog.getByRole("button", { name: "正在上传…" })
  ).toBeVisible()
  releaseSubmission()
  await expect(page.getByRole("status")).toContainText("建议已提交")
  const submission = fixture.getLastSubmission()
  expect(submission).toMatchObject({
    projectId: PROJECT_ALERT,
    title: "图片审核建议",
    description: "图片失败时正文、投票和时间轴都必须保留",
  })
  expect(submission?.image).toMatchObject({
    name: selectedImage.name,
    type: selectedImage.mimeType,
    size: PNG_BYTES.length,
  })
  await expect(
    page.getByText("图片审核建议", { exact: true })
  ).toBeVisible()

  const suggestionCard = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "图片审核建议" })
  await suggestionCard.getByRole("button", { name: "查看详情" }).click()
  const details = page.getByRole("dialog")
  const moderationNotice = details.getByRole("region", { name: "建议图片" })
  await expect(moderationNotice).toContainText(
    "图片正在审核，通过后将在此显示"
  )
  const moderationColors = await moderationNotice.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, foreground: style.color }
  })
  expect(moderationColors.background).not.toBe("rgba(0, 0, 0, 0)")
  expect(moderationColors.foreground).not.toBe(moderationColors.background)
  expect(fixture.getMediaRequestCount()).toBe(0)
  await details.getByRole("button", { name: "关闭" }).click()

  fixture.approveSuggestion()
  await page.getByLabel("切换项目").selectOption(PROJECT_ADS)
  await page.getByLabel("切换项目").selectOption(PROJECT_ALERT)
  fixture.abortNextMedia()
  await suggestionCard.getByRole("button", { name: "查看详情" }).click()
  await expect(details.getByText("图片加载失败，请重试")).toBeVisible()
  await expect(details.getByText("图片失败时正文、投票和时间轴都必须保留")).toBeVisible()
  await expect(
    details.getByRole("button", { name: "为“图片审核建议”投票" })
  ).toBeVisible()
  await expect(
    details.getByRole("region", { name: "进展时间轴" })
  ).toBeVisible()
  await details.getByRole("button", { name: "重新加载" }).click()
  await expect(
    details.getByRole("img", { name: "图片审核建议 的建议图片" })
  ).toBeVisible()
  expect(fixture.getMediaRequestCount()).toBe(2)

  await details.getByRole("button", { name: "关闭" }).click()
  await suggestionCard.getByRole("button", { name: "查看详情" }).click()
  await expect(
    details.getByRole("img", { name: "图片审核建议 的建议图片" })
  ).toBeVisible()

  const detailMetrics = await details.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(detailMetrics.scrollWidth).toBeLessThanOrEqual(detailMetrics.clientWidth)
})
