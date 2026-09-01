import { createHmac, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { chromium } from "@playwright/test"
import ipaddr from "ipaddr.js"
import { readDeploymentInputs } from "../deployment-inputs.mjs"
import { assertTaskIdentity, readTaskInputs } from "./config.mjs"
import { runCaptured } from "./command.mjs"
import { parseDbQueryColumn } from "./database.mjs"
import { createSupabaseProvider } from "./providers.mjs"
import {
  TASK_COPY_RECEIPT_FILE,
  TASK_SMOKE_RECEIPT_FILE,
  createSmokeReceipt,
  readCopyReceipt,
  writeReceiptAtomic,
} from "./receipts.mjs"

const ALLOWED_HOSTS = new Set([
  "task-roadmap-ui.pages.dev",
  "task.telljax.com",
])
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNgaPj/H4xhDABS0gn50Ke7SAAAAABJRU5ErkJggg==",
  "base64",
)
const EXPECTED_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https://*.supabase.co; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
}

export function assertAllowedSmokeUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error("冒烟地址不是 Task Roadmap")
  }
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("冒烟地址不是 Task Roadmap")
  }
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url
}

export function assertSupabaseRequestHost(value, targetProjectRef) {
  const url = new URL(value)
  if (!url.hostname.endsWith(".supabase.co")) return false
  if (url.hostname !== `${targetProjectRef}.supabase.co`) {
    throw new Error("浏览器请求了非目标 Supabase，已中止冒烟测试")
  }
  return true
}

export function assertMediaHeaders(headers, expectedSize) {
  const expected = {
    "cache-control": "public, max-age=3600, s-maxage=86400",
    "content-disposition": "inline",
    "content-length": String(expectedSize),
    "content-type": "image/png",
    "x-content-type-options": "nosniff",
  }
  for (const [name, value] of Object.entries(expected)) {
    if (headers[name] !== value) throw new Error(`目标图片响应头 ${name} 不符合预期`)
  }
}

export function assertSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    if (headers.get(name) !== value) {
      throw new Error(`目标安全响应头不符合预期：${name}`)
    }
  }
}

export async function runSmokeWorkflow(adapters) {
  assertAllowedSmokeUrl(adapters.baseUrl)
  const sourceBefore = await adapters.readSourceCounters()
  let fixtureIdentity
  let operationalState
  let browser
  let fixtures
  let failure = null
  try {
    fixtureIdentity = await adapters.createFixtureIdentity()
    operationalState = await adapters.captureOperationalState()
    if (adapters.verifySecurityHeaders) await adapters.verifySecurityHeaders()
    browser = await adapters.openBrowser()
    fixtures = await adapters.submitFixtures(browser, fixtureIdentity)
    await adapters.verifyAdminAndApprove(browser, fixtures)
    await adapters.verifyMediaCache(browser, fixtures)
    await adapters.verifyDuplicateVote(browser, fixtures)
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    try {
      if (fixtureIdentity) {
        await adapters.cleanupFixtures(browser, fixtures, fixtureIdentity)
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (operationalState) await adapters.restoreOperationalState(operationalState)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (operationalState && fixtureIdentity) {
        await adapters.verifyTargetRestored(operationalState, fixtureIdentity)
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await adapters.closeBrowser(browser)
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      const sourceAfter = await adapters.readSourceCounters()
      if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
        throw new Error("源 Roadmap 在目标冒烟期间发生变化")
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      failure = new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        `冒烟清理失败（${cleanupErrors.length} 项）`,
      )
    }
  }

  if (failure) throw failure
  return { ok: true }
}

function headersFor(key, bearer = key) {
  return {
    apikey: key,
    Authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    "User-Agent": "task-roadmap-smoke/1.0",
  }
}

async function checkedJson(response, message) {
  if (!response.ok) throw new Error(`${message}（HTTP ${response.status}）`)
  return response.status === 204 ? null : response.json()
}

async function publicCounters(inputs) {
  const headers = headersFor(inputs.SUPABASE_PUBLISHABLE_KEY)
  const [projects, items] = await Promise.all([
    fetch(`${inputs.SUPABASE_URL}/rest/v1/projects?select=id&order=id.asc`, {
      headers,
    }).then((response) => checkedJson(response, "读取源项目数量失败")),
    fetch(
      `${inputs.SUPABASE_URL}/rest/v1/roadmap_items_public?select=id,vote_count&order=id.asc`,
      { headers },
    ).then((response) => checkedJson(response, "读取源 Roadmap 数量失败")),
  ])
  const voteTotal = items
    .reduce((total, item) => total + BigInt(item.vote_count), 0n)
    .toString()
  return { projects: projects.length, items: items.length, voteTotal }
}

export function operationalSnapshotSql({ suggestionHash, imageHash }) {
  if (![suggestionHash, imageHash].every((value) => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("目标冒烟运行态哈希无效")
  }
  return `begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'suggestionRateLimits', coalesce((select jsonb_agg(jsonb_build_object(
    'ipHash', ip_hash, 'windowStartedAt', window_started_at, 'submissionCount', submission_count
  ) order by ip_hash, window_started_at) from public.suggestion_rate_limits
    where ip_hash = '${suggestionHash}'), '[]'::jsonb),
  'suggestionImageRateLimits', coalesce((select jsonb_agg(jsonb_build_object(
    'id', id::text, 'ipHash', ip_hash, 'createdAt', created_at
  ) order by id) from public.suggestion_image_rate_limits
    where ip_hash = '${imageHash}'), '[]'::jsonb),
  'operationalCounts', jsonb_build_object(
    'votes', (select count(*) from public.votes),
    'suggestionRateLimits', (select count(*) from public.suggestion_rate_limits),
    'suggestionImageRateLimits', (select count(*) from public.suggestion_image_rate_limits)
  )
) as operational;
commit;`
}

export function restoreOperationalSql(snapshot) {
  const { suggestionHash, imageHash, ...rows } = snapshot
  if (![suggestionHash, imageHash].every((value) => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("目标冒烟运行态哈希无效")
  }
  const payload = Buffer.from(JSON.stringify(rows), "utf8").toString("base64")
  return `begin;
select pg_advisory_xact_lock(hashtextextended('task-roadmap-smoke-v1', 0));
create temporary table task_smoke_state (document jsonb not null) on commit drop;
insert into task_smoke_state values (
  convert_from(decode($state$${payload}$state$, 'base64'), 'UTF8')::jsonb
);
delete from public.suggestion_rate_limits where ip_hash = '${suggestionHash}';
delete from public.suggestion_image_rate_limits where ip_hash = '${imageHash}';
insert into public.suggestion_rate_limits (ip_hash, window_started_at, submission_count)
select source."ipHash", source."windowStartedAt", source."submissionCount"
from task_smoke_state
cross join lateral jsonb_to_recordset(document -> 'suggestionRateLimits') as source(
  "ipHash" text, "windowStartedAt" timestamptz, "submissionCount" integer
);
insert into public.suggestion_image_rate_limits (id, ip_hash, created_at) overriding system value
select source."id"::bigint, source."ipHash", source."createdAt"
from task_smoke_state
cross join lateral jsonb_to_recordset(document -> 'suggestionImageRateLimits') as source(
  "id" text, "ipHash" text, "createdAt" timestamptz
);
commit;`
}

function createProductionAdapters({
  baseUrl,
  sourceInputs,
  targetInputs,
  appCommit,
}) {
  assertTaskIdentity(sourceInputs, targetInputs)
  let activeContext = null
  let activePage = null
  let backendViolation = null
  let sawTargetBackend = false
  let targetDatabase = null

  async function createGuardedContext(browser) {
    const context = await browser.newContext()
    await context.route("**/*", async (route) => {
      try {
        if (
          assertSupabaseRequestHost(
            route.request().url(),
            targetInputs.SUPABASE_PROJECT_REF,
          )
        ) {
          sawTargetBackend = true
        }
        await route.continue()
      } catch (error) {
        backendViolation = error
        await route.abort("blockedbyclient")
      }
    })
    return context
  }

  function assertBrowserTarget() {
    if (backendViolation) throw backendViolation
    if (!sawTargetBackend) {
      throw new Error("浏览器尚未验证目标 Supabase 主机")
    }
  }

  async function assertDeploymentCommit(page) {
    const actual = await page
      .locator('meta[name="roadmap-deploy-commit"]')
      .getAttribute("content")
    if (actual !== appCommit) throw new Error("页面部署提交与冒烟回执不匹配")
  }

  async function normalizedClientIp() {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      headers: { "User-Agent": "task-roadmap-smoke/1.0" },
    })
    if (!response.ok) throw new Error("无法读取冒烟出口 IP")
    const ip = (await response.text())
      .split(/\r?\n/)
      .find((line) => line.startsWith("ip="))
      ?.slice(3)
    const address = ipaddr.parse(ip ?? "")
    return address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()
      ? address.toIPv4Address().toString()
      : address.toString()
  }

  function hmacIp(ip, scope) {
    return createHmac("sha256", `${scope}:${targetInputs.VOTE_IP_SALT}`)
      .update(ip)
      .digest("hex")
  }

  async function getTargetDatabase() {
    if (targetDatabase) return targetDatabase
    const supabase = createSupabaseProvider({
      accessToken: sourceInputs.SUPABASE_ACCESS_TOKEN,
      protectedProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
      protectedSecretKey: sourceInputs.SUPABASE_SECRET_KEY,
      runCommand: runCaptured,
      workdir: process.cwd(),
    })
    const projects = await supabase.listProjects()
    const target = projects.find(
      (project) =>
        (project.ref ?? project.id) === targetInputs.SUPABASE_PROJECT_REF,
    )
    if (!target) throw new Error("找不到目标 Supabase 项目")
    targetDatabase = { supabase, target }
    return targetDatabase
  }

  async function queryTarget(sql, operation, readOnly = false) {
    const { supabase, target } = await getTargetDatabase()
    return supabase.queryDatabase({
      projectRef: targetInputs.SUPABASE_PROJECT_REF,
      region: target.region,
      databasePassword: targetInputs.SUPABASE_DB_PASSWORD,
      sql,
      operation,
      readOnly,
    })
  }

  async function serviceRows(path) {
    return checkedJson(
      await fetch(`${targetInputs.SUPABASE_URL}/rest/v1/${path}`, {
        headers: headersFor(targetInputs.SUPABASE_SECRET_KEY),
      }),
      "读取目标清理数据失败",
    )
  }

  async function selectFixtureProject(page) {
    const select = page.getByLabel("切换项目")
    await select.waitFor()
    return select.inputValue()
  }

  async function submitSuggestion(page, { title, description, image }) {
    assertBrowserTarget()
    await page.getByRole("button", { name: "提交建议" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("建议标题").fill(title)
    await dialog.getByLabel("详细说明").fill(description)
    if (image) {
      await dialog.getByLabel("附加图片（可选）").setInputFiles({
        name: "task-roadmap-smoke.png",
        mimeType: "image/png",
        buffer: PNG_BYTES,
      })
    }
    await dialog.getByRole("button", { name: "确认提交" }).click()
    await page.getByRole("status").filter({ hasText: "建议已提交" }).waitFor()
    assertBrowserTarget()
  }

  async function openPublicPage(browser, projectId) {
    if (activeContext) await activeContext.close()
    activeContext = await createGuardedContext(browser)
    activePage = await activeContext.newPage()
    await activePage.goto(baseUrl.href)
    await assertDeploymentCommit(activePage)
    assertBrowserTarget()
    if (projectId) await activePage.getByLabel("切换项目").selectOption(projectId)
    return activePage
  }

  async function locateFixtureRows(titles) {
    const encoded = encodeURIComponent(`in.(${titles.map((title) => `"${title}"`).join(",")})`)
    return serviceRows(`roadmap_items?select=id,title,project_id,status&title=${encoded}`)
  }

  return {
    baseUrl: baseUrl.href,
    readSourceCounters: () => publicCounters(sourceInputs),
    createFixtureIdentity() {
      const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
      return {
        prefix: `__task_smoke_${suffix}`,
        textTitle: `__task_smoke_${suffix}_text`,
        imageTitle: `__task_smoke_${suffix}_image`,
      }
    },
    async captureOperationalState() {
      const ip = await normalizedClientIp()
      const hashes = {
        suggestionHash: hmacIp(ip, "suggestion"),
        imageHash: hmacIp(ip, "suggestion-image"),
      }
      const result = await queryTarget(
        operationalSnapshotSql(hashes),
        "读取目标冒烟前运行状态",
        true,
      )
      return {
        ...hashes,
        ...parseDbQueryColumn(
          result.stdout,
          "operational",
          "目标冒烟前运行状态无效",
        ),
      }
    },
    openBrowser: () => chromium.launch({ headless: true }),
    async verifySecurityHeaders() {
      for (const path of ["/", "/admin/"]) {
        const response = await fetch(new URL(path, baseUrl))
        if (!response.ok) throw new Error(`目标页面不可用：${path}`)
        assertSecurityHeaders(response.headers)
      }
    },
    async submitFixtures(browser, identity) {
      const { textTitle, imageTitle } = identity
      const page = await openPublicPage(browser)
      const projectId = await selectFixtureProject(page)
      await submitSuggestion(page, {
        title: textTitle,
        description: "Task Roadmap 自动化纯文字验收，可安全删除。",
        image: false,
      })
      await submitSuggestion(page, {
        title: imageTitle,
        description: "Task Roadmap 自动化图片、缓存和投票验收，可安全删除。",
        image: true,
      })
      const rows = await locateFixtureRows([textTitle, imageTitle])
      if (rows.length !== 2) throw new Error("未找到完整的目标冒烟条目")
      return {
        projectId,
        textTitle,
        imageTitle,
        itemIds: rows.map((row) => row.id),
      }
    },
    async verifyAdminAndApprove(browser, fixtures) {
      if (activeContext) await activeContext.close()
      activeContext = await createGuardedContext(browser)
      activePage = await activeContext.newPage()
      await activePage.goto(new URL("/admin/", baseUrl).href)
      await assertDeploymentCommit(activePage)
      assertBrowserTarget()
      await activePage.getByLabel("管理密码").fill(targetInputs.ADMIN_PASSWORD)
      await activePage.getByRole("button", { name: "进入管理端" }).click()
      await activePage.getByRole("heading", { name: "路线图管理" }).waitFor()
      await activePage.getByLabel("切换项目").selectOption(fixtures.projectId)
      await activePage
        .getByRole("button", { name: `编辑“${fixtures.imageTitle}”` })
        .click()
      const dialog = activePage.getByRole("dialog")
      await dialog.getByLabel("当前阶段").selectOption("approved")
      await dialog.getByRole("button", { name: "保存条目" }).click()
      await activePage
        .getByRole("region", { name: "已批准" })
        .getByRole("heading", { name: fixtures.imageTitle })
        .waitFor()
      assertBrowserTarget()
    },
    async verifyMediaCache(browser, fixtures) {
      const firstPage = await openPublicPage(browser, fixtures.projectId)
      const firstResponsePromise = firstPage.waitForResponse((response) =>
        new URL(response.url()).pathname.startsWith("/media/"),
      )
      const card = firstPage
        .locator('[data-slot="card"]')
        .filter({ hasText: fixtures.imageTitle })
      await card.getByRole("button", { name: "查看详情" }).click()
      const firstResponse = await firstResponsePromise
      assertMediaHeaders(firstResponse.headers(), PNG_BYTES.length)
      if (
        !firstResponse.ok() ||
        firstResponse.headers()["x-roadmap-cache"] !== "MISS"
      ) {
        throw new Error("目标图片首次缓存响应不是 MISS")
      }
      await firstPage
        .getByRole("img", { name: `${fixtures.imageTitle} 的建议图片` })
        .waitFor()

      const secondPage = await openPublicPage(browser, fixtures.projectId)
      const secondResponsePromise = secondPage.waitForResponse((response) =>
        new URL(response.url()).pathname.startsWith("/media/"),
      )
      const secondCard = secondPage
        .locator('[data-slot="card"]')
        .filter({ hasText: fixtures.imageTitle })
      await secondCard.getByRole("button", { name: "查看详情" }).click()
      const secondResponse = await secondResponsePromise
      assertMediaHeaders(secondResponse.headers(), PNG_BYTES.length)
      if (
        !secondResponse.ok() ||
        secondResponse.headers()["x-roadmap-cache"] !== "HIT"
      ) {
        throw new Error("目标图片第二次缓存响应不是 HIT")
      }
      await secondPage
        .getByRole("button", { name: `查看“${fixtures.imageTitle}”大图` })
        .click()
      await secondPage
        .getByRole("dialog", { name: `${fixtures.imageTitle} 大图` })
        .waitFor()
      await secondPage.getByRole("button", { name: "关闭大图" }).click()
    },
    async verifyDuplicateVote(_browser, fixtures) {
      const dialog = activePage.getByRole("dialog")
      const vote = dialog.getByRole("button", {
        name: `为“${fixtures.imageTitle}”投票`,
      })
      await vote.click()
      await activePage.getByRole("status").filter({ hasText: "投票成功" }).waitFor()
      await vote.click()
      await activePage
        .getByRole("status")
        .filter({ hasText: "当前网络已投过票" })
        .waitFor()
    },
    async cleanupFixtures(_browser, _fixtures, identity) {
      const rows = await locateFixtureRows([identity.textTitle, identity.imageTitle])
      if (rows.length === 0) return
      const authHeaders = headersFor(targetInputs.SUPABASE_SECRET_KEY)
      const idFilter = encodeURIComponent(`in.(${rows.map((row) => row.id).join(",")})`)
      const images = await serviceRows(
        `roadmap_item_images?select=roadmap_item_id,storage_path&roadmap_item_id=${idFilter}`,
      )
      const cleanupErrors = []
      for (const image of images) {
        const path = image.storage_path
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")
        try {
          const response = await fetch(
            `${targetInputs.SUPABASE_URL}/storage/v1/object/roadmap-images/${path}`,
            { method: "DELETE", headers: authHeaders },
          )
          if (!response.ok && response.status !== 404) {
            cleanupErrors.push(new Error("冒烟图片清理失败"))
          }
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        const response = await fetch(
          `${targetInputs.SUPABASE_URL}/rest/v1/roadmap_items?id=${idFilter}`,
          { method: "DELETE", headers: authHeaders },
        )
        if (!response.ok) cleanupErrors.push(new Error("冒烟 Roadmap 条目清理失败"))
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        const remaining = await locateFixtureRows([identity.textTitle, identity.imageTitle])
        if (remaining.length !== 0) {
          cleanupErrors.push(new Error("冒烟数据清理后仍然存在"))
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, `冒烟测试数据清理失败（${cleanupErrors.length} 项）`)
      }
    },
    async restoreOperationalState(snapshot) {
      await queryTarget(
        restoreOperationalSql(snapshot),
        "精确恢复目标冒烟前运行状态",
      )
    },
    async verifyTargetRestored(snapshot, identity) {
      const remaining = await locateFixtureRows([identity.textTitle, identity.imageTitle])
      if (remaining.length !== 0) throw new Error("冒烟数据清理后仍然存在")
      const result = await queryTarget(
        operationalSnapshotSql(snapshot),
        "核对目标冒烟后运行状态",
        true,
      )
      const current = {
        suggestionHash: snapshot.suggestionHash,
        imageHash: snapshot.imageHash,
        ...parseDbQueryColumn(
          result.stdout,
          "operational",
          "目标冒烟后运行状态无效",
        ),
      }
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
        throw new Error("目标运行状态未精确恢复")
      }
    },
    async closeBrowser(browser) {
      if (activeContext) await activeContext.close().catch(() => {})
      if (browser) await browser.close()
    },
  }
}

function argument(name) {
  const exactIndex = process.argv.indexOf(name)
  if (exactIndex >= 0) return process.argv[exactIndex + 1]
  const prefix = `${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

async function main() {
  const baseUrl = assertAllowedSmokeUrl(
    argument("--base-url") ?? "https://task-roadmap-ui.pages.dev",
  )
  const [sourceInputs, targetInputs] = await Promise.all([
    readDeploymentInputs(".env.deploy.local"),
    readTaskInputs(".env.task.deploy.local"),
  ])
  assertTaskIdentity(sourceInputs, targetInputs)
  const copyReceipt = await readCopyReceipt(TASK_COPY_RECEIPT_FILE)
  const git = await runCaptured("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    operation: "读取冒烟提交",
  })
  if (
    copyReceipt.sourceProjectRef !== sourceInputs.SUPABASE_PROJECT_REF ||
    copyReceipt.targetProjectRef !== targetInputs.SUPABASE_PROJECT_REF ||
    copyReceipt.appCommit !== git.stdout.trim()
  ) {
    throw new Error("复制回执与当前冒烟目标或提交不匹配")
  }
  await runSmokeWorkflow(
    createProductionAdapters({
      baseUrl,
      sourceInputs,
      targetInputs,
      appCommit: git.stdout.trim(),
    }),
  )
  await writeReceiptAtomic(
    TASK_SMOKE_RECEIPT_FILE,
    createSmokeReceipt({
      baseUrl,
      targetProjectRef: targetInputs.SUPABASE_PROJECT_REF,
      appCommit: git.stdout.trim(),
      copyDigest: copyReceipt.manifestDigest,
    }),
  )
  process.stdout.write("Task Roadmap 线上冒烟通过，测试数据已清理。\n")
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : ""
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
