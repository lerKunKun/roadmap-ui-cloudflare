import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import pg from "pg"

import {
  readDeploymentInputs,
  validateDeploymentInputs,
} from "../deployment-inputs.mjs"
import {
  buildAdvertisingSyncCronSql,
  buildAdvertisingSyncInfrastructureSql,
  buildAdvertisingSyncStatusSql,
  buildAdvertisingSyncTargetTestSql,
  buildAdvertisingSyncVaultSql,
} from "./advertising-sync-database.mjs"
import { runCaptured } from "./command.mjs"
import {
  TASK_DEPLOYMENT_INPUTS_FILE,
  assertTaskIdentity,
  ensureAdvertisingSyncCronSecret,
  readTaskInputs,
} from "./config.mjs"
import { parseDbQueryColumn } from "./database.mjs"
import { createSupabaseProvider } from "./providers.mjs"

export const ADVERTISING_SYNC_ACCEPTANCE_RECEIPT_FILE =
  ".task-roadmap-advertising-sync-acceptance.json"

function syncIdentityError() {
  return new Error("同步项目身份无效")
}

export function assertAdvertisingSyncIdentity({
  sourceProjectRef,
  targetProjectRef,
  targetUrl,
  publishableKey,
  cronSecret,
}) {
  if (
    !/^[a-z0-9]{20}$/.test(sourceProjectRef ?? "") ||
    !/^[a-z0-9]{20}$/.test(targetProjectRef ?? "") ||
    sourceProjectRef === targetProjectRef ||
    targetUrl !== `https://${targetProjectRef}.supabase.co` ||
    !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(publishableKey ?? "") ||
    !/^[a-f0-9]{64}$/.test(cronSecret ?? "")
  ) {
    throw syncIdentityError()
  }
}

export async function installAdvertisingSync(context) {
  await context.assertIdentity()
  await context.applySourceMigration()
  await context.applyTargetMigrations()
  await context.applyTargetInfrastructure()
  await context.setEdgeSecrets()
  await context.deployEdgeFunction()
  await context.configureVault()
  await context.configureCron(false)
  const status = await context.readStatus()
  if (status?.cronActive !== false) {
    throw new Error("广告同步安装后 Cron 未保持停用")
  }
  return status
}

export async function triggerAdvertisingSync({
  sourceProjectRef,
  targetProjectRef,
  targetUrl,
  publishableKey,
  cronSecret,
  fetchImpl = fetch,
}) {
  assertAdvertisingSyncIdentity({
    sourceProjectRef,
    targetProjectRef,
    targetUrl,
    publishableKey,
    cronSecret,
  })
  let response
  try {
    response = await fetchImpl(`${targetUrl}/functions/v1/sync-advertising`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "content-type": "application/json",
        "x-roadmap-sync-secret": cronSecret,
      },
      body: "{}",
    })
  } catch {
    throw new Error("手动触发广告同步失败（网络不可用）")
  }
  let result = null
  try {
    result = await response.json()
  } catch {
    result = null
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error(`手动触发广告同步失败（HTTP ${response.status}）`)
  }
  return result
}

/**
 * @param {{
 *   active: boolean,
 *   sourceProjectRef?: string | null,
 *   targetProjectRef?: string | null,
 *   appCommit?: string | null,
 *   status?: { lastSnapshotDigest?: string | null, cleanupCount?: number } | null,
 *   acceptanceReceipt?: {
 *     sourceProjectRef?: string,
 *     targetProjectRef?: string,
 *     appCommit?: string,
 *     snapshotDigest?: string,
 *     checks?: { sourceUnchanged?: boolean, targetSentinelUnchanged?: boolean }
 *   } | null,
 *   configureCron: (active: boolean) => Promise<unknown>
 * }} input
 */
export async function setAdvertisingSyncCronActive({
  active,
  sourceProjectRef = null,
  targetProjectRef = null,
  appCommit = null,
  status = null,
  acceptanceReceipt = null,
  configureCron,
}) {
  if (active === true) {
    const accepted =
      status?.lastSnapshotDigest &&
      status.cleanupCount === 0 &&
      acceptanceReceipt?.sourceProjectRef === sourceProjectRef &&
      acceptanceReceipt?.targetProjectRef === targetProjectRef &&
      acceptanceReceipt?.appCommit === appCommit &&
      acceptanceReceipt?.snapshotDigest === status.lastSnapshotDigest &&
      acceptanceReceipt?.checks?.sourceUnchanged === true &&
      acceptanceReceipt?.checks?.targetSentinelUnchanged === true
    if (!accepted) throw new Error("自动同步启用条件未满足")
  } else if (active !== false) {
    throw new Error("Cron active 状态无效")
  }
  await configureCron(active)
  return { active }
}

function normalizeStatus(raw) {
  return {
    installed: Boolean(raw),
    lastAttemptAt: raw?.lastAttemptAt ?? null,
    lastSuccessAt: raw?.lastSuccessAt ?? null,
    lastSnapshotDigest: raw?.lastSnapshotDigest ?? null,
    lastCounts: raw?.lastCounts ?? null,
    lastDurationMs: raw?.lastDurationMs ?? null,
    lastErrorCode: raw?.lastErrorCode ?? null,
    busy: raw?.busy === true,
    cleanupCount: Number(raw?.cleanup_count ?? 0),
    cronActive: raw?.cron?.active === true,
    cronSchedule: raw?.cron?.schedule ?? null,
  }
}

async function loadRuntime() {
  const sourceInputs = await readDeploymentInputs(".env.deploy.local")
  const sourceErrors = validateDeploymentInputs(sourceInputs)
  if (sourceErrors.length > 0) throw new Error("源部署配置无效")

  let targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  if (!targetInputs.ADVERTISING_SYNC_CRON_SECRET) {
    await ensureAdvertisingSyncCronSecret(
      TASK_DEPLOYMENT_INPUTS_FILE,
      targetInputs.SUPABASE_PROJECT_REF
    )
    targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  }
  assertTaskIdentity(sourceInputs, targetInputs)
  assertAdvertisingSyncIdentity({
    sourceProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
    targetProjectRef: targetInputs.SUPABASE_PROJECT_REF,
    targetUrl: targetInputs.SUPABASE_URL,
    publishableKey: targetInputs.SUPABASE_PUBLISHABLE_KEY,
    cronSecret: targetInputs.ADVERTISING_SYNC_CRON_SECRET,
  })

  const supabase = createSupabaseProvider({
    accessToken: sourceInputs.SUPABASE_ACCESS_TOKEN,
    protectedProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
    protectedSecretKey: sourceInputs.SUPABASE_SECRET_KEY,
    runCommand: runCaptured,
    workdir: process.cwd(),
  })
  const projects = await supabase.listProjects()
  const projectRef = (project) => project?.ref ?? project?.id
  const source = projects.find(
    (project) => projectRef(project) === sourceInputs.SUPABASE_PROJECT_REF
  )
  const target = projects.find(
    (project) => projectRef(project) === targetInputs.SUPABASE_PROJECT_REF
  )
  if (!source || !target) throw new Error("找不到同步所需 Supabase 项目")

  const targetQuery = ({ sql, operation, readOnly = false }) =>
    supabase.queryDatabase({
      projectRef: targetInputs.SUPABASE_PROJECT_REF,
      region: target.region,
      databasePassword: targetInputs.SUPABASE_DB_PASSWORD,
      sql,
      operation,
      readOnly,
    })
  const readStatus = async () => {
    const result = await targetQuery({
      sql: buildAdvertisingSyncStatusSql(),
      operation: "读取广告同步状态",
      readOnly: true,
    })
    return normalizeStatus(
      parseDbQueryColumn(result.stdout, "status", "广告同步状态无效")
    )
  }

  return {
    sourceInputs,
    targetInputs,
    supabase,
    source,
    target,
    targetQuery,
    readStatus,
  }
}

async function installCommand(runtime) {
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/20260902090000_advertising_sync_export.sql"
  )
  const migration = await readFile(migrationPath)
  const expectedSha256 = createHash("sha256").update(migration).digest("hex")
  return installAdvertisingSync({
    assertIdentity: async () => {},
    applySourceMigration: () =>
      runtime.supabase.applyProtectedSourceMigration({
        projectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
        region: runtime.source.region,
        databasePassword: runtime.sourceInputs.SUPABASE_DB_PASSWORD,
        migrationPath,
        expectedSha256,
      }),
    applyTargetMigrations: () =>
      runtime.supabase.applyMigrations({
        projectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
        region: runtime.target.region,
        databasePassword: runtime.targetInputs.SUPABASE_DB_PASSWORD,
      }),
    applyTargetInfrastructure: () =>
      runtime.targetQuery({
        sql: buildAdvertisingSyncInfrastructureSql(
          runtime.targetInputs.SUPABASE_PROJECT_REF
        ),
        operation: "安装目标广告同步数据库对象",
      }),
    setEdgeSecrets: () =>
      runtime.supabase.setAdvertisingSyncEdgeSecrets({
        targetProjectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
        cronSecret: runtime.targetInputs.ADVERTISING_SYNC_CRON_SECRET,
        sourceUrl: runtime.sourceInputs.SUPABASE_URL,
        sourceSecretKey: runtime.sourceInputs.SUPABASE_SECRET_KEY,
        sourceProjectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
      }),
    deployEdgeFunction: () =>
      runtime.supabase.deployEdgeFunction(
        runtime.targetInputs.SUPABASE_PROJECT_REF,
        "sync-advertising"
      ),
    configureVault: () =>
      runtime.targetQuery({
        sql: buildAdvertisingSyncVaultSql({
          functionUrl: `${runtime.targetInputs.SUPABASE_URL}/functions/v1/sync-advertising`,
          publishableKey: runtime.targetInputs.SUPABASE_PUBLISHABLE_KEY,
          cronSecret: runtime.targetInputs.ADVERTISING_SYNC_CRON_SECRET,
        }),
        operation: "配置广告同步 Vault",
      }),
    configureCron: (active) =>
      runtime.targetQuery({
        sql: buildAdvertisingSyncCronSql({ active }),
        operation: "配置广告同步 Cron",
      }),
    readStatus: runtime.readStatus,
  })
}

async function testTargetCommand() {
  const testSql = await readFile(
    resolve(
      process.cwd(),
      "supabase/tests/target/advertising-sync-target.test.sql"
    ),
    "utf8"
  )
  const sql = buildAdvertisingSyncTargetTestSql("bcdefghijklmnopqrstu", testSql)
  const client = new pg.Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  })
  await client.connect()
  try {
    const raw = await client.query(sql)
    const results = Array.isArray(raw) ? raw : [raw]
    const lines = results.flatMap((result) =>
      (result.rows ?? []).flatMap((row) =>
        Object.values(row).filter((value) => typeof value === "string")
      )
    )
    const failures = lines.filter((line) => line.startsWith("not ok"))
    const plan = lines.find((line) => line.startsWith("1.."))
    if (failures.length > 0 || plan !== "1..26") {
      throw new Error("目标广告同步 pgTAP 验收失败")
    }
    return { checks: 26, passed: true }
  } finally {
    await client.end()
  }
}

async function executeCommand(command) {
  if (command === "test-target") return testTargetCommand()
  const runtime = await loadRuntime()
  if (command === "install") return installCommand(runtime)
  if (command === "trigger") {
    return triggerAdvertisingSync({
      sourceProjectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
      targetProjectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
      targetUrl: runtime.targetInputs.SUPABASE_URL,
      publishableKey: runtime.targetInputs.SUPABASE_PUBLISHABLE_KEY,
      cronSecret: runtime.targetInputs.ADVERTISING_SYNC_CRON_SECRET,
    })
  }
  if (command === "status") return runtime.readStatus()
  if (command === "enable" || command === "disable") {
    const active = command === "enable"
    const [status, appCommit, acceptanceReceipt] = await Promise.all([
      runtime.readStatus(),
      runCaptured("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        operation: "读取广告同步部署提交",
      }).then((result) => result.stdout.trim()),
      active
        ? readFile(
            resolve(process.cwd(), ADVERTISING_SYNC_ACCEPTANCE_RECEIPT_FILE),
            "utf8"
          ).then(JSON.parse)
        : Promise.resolve(null),
    ])
    return setAdvertisingSyncCronActive({
      active,
      sourceProjectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
      targetProjectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
      appCommit,
      status,
      acceptanceReceipt,
      configureCron: (nextActive) =>
        runtime.targetQuery({
          sql: buildAdvertisingSyncCronSql({ active: nextActive }),
          operation: nextActive ? "启用广告同步 Cron" : "停用广告同步 Cron",
        }),
    })
  }
  throw new Error("未知广告同步命令")
}

async function main() {
  const result = await executeCommand(process.argv[2] ?? "status")
  const safeSummary = {
    installed: result?.installed,
    active: result?.active ?? result?.cronActive,
    lastSuccessAt: result?.lastSuccessAt,
    digest: result?.lastSnapshotDigest?.slice(0, 12) ?? result?.digest,
    cleanupCount: result?.cleanupCount,
    checks: result?.checks,
    passed: result?.passed,
  }
  const summary = Object.entries(safeSummary)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  process.stdout.write(`广告系统同步命令完成${summary ? `：${summary}` : ""}\n`)
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
