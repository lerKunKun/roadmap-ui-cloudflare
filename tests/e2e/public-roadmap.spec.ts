import { expect, test, type Page } from "@playwright/test"

const PROJECT_ADS = "11111111-1111-4111-8111-111111111111"
const PROJECT_ALERT = "22222222-2222-4222-8222-222222222222"
const ITEM_ALERT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

const projects = [
  { id: PROJECT_ADS, name: "广告系统", slug: "advertising-system", project_url: "https://ads.example.test/", sort_order: 0 },
  { id: PROJECT_ALERT, name: "ks-alert", slug: "ks-alert", project_url: null, sort_order: 1 },
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
    created_at: "2026-08-24T08:00:00.000Z",
    updated_at: "2026-08-24T08:00:00.000Z",
  }
}

async function installPublicApi(page: Page) {
  const items = [item(ITEM_ALERT, PROJECT_ALERT, "告警通知聚合")]
  let voted = false

  await page.route("https://e2e.supabase.co/rest/v1/projects**", async (route) => {
    await route.fulfill({ json: projects })
  })
  await page.route("https://e2e.supabase.co/rest/v1/roadmap_items_public**", async (route) => {
    const projectId = new URL(route.request().url()).searchParams.get("project_id")?.replace("eq.", "")
    await route.fulfill({ json: items.filter((entry) => entry.project_id === projectId) })
  })
  await page.route("https://e2e.supabase.co/functions/v1/submit-suggestion", async (route) => {
    const body = route.request().postDataJSON() as { projectId: string; title: string; description: string }
    items.push({ ...item("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", body.projectId, body.title), description: body.description })
    await route.fulfill({ status: 201, json: { itemId: items.at(-1)!.id } })
  })
  await page.route("https://e2e.supabase.co/functions/v1/vote", async (route) => {
    const target = items.find((entry) => entry.id === ITEM_ALERT)!
    if (!voted) target.vote_count += 1
    await route.fulfill({ json: { voteCount: target.vote_count, duplicate: voted } })
    voted = true
  })
}

test("公开端可切换项目、提交建议并按网络去重投票", async ({ page }) => {
  await installPublicApi(page)
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "Roadmap 路线图" })).toBeVisible()
  await expect(page.getByRole("region", { name: "项目路线图" }).getByRole("region")).toHaveCount(5)

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
  const boardMetrics = await page.locator(".roadmap-board").evaluate((board) => ({
    clientWidth: board.clientWidth,
    scrollWidth: board.scrollWidth,
  }))
  expect(boardMetrics.scrollWidth).toBeGreaterThan(boardMetrics.clientWidth)
})
