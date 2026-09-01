import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  readDeploymentInputs,
  validateDeploymentInputs,
} from "../deployment-inputs.mjs"
import { auditTarget, captureSourceSnapshot, importSnapshot } from "./database.mjs"
import { runCaptured } from "./command.mjs"
import {
  TASK_ADMIN_EMAIL,
  TASK_DEPLOYMENT_INPUTS_FILE,
  TASK_DOMAIN,
  TASK_PAGES_PROJECT,
  generateTargetSecrets,
  readTaskInputs,
  validateTaskIdentity,
  writeTargetInputsAtomic,
} from "./config.mjs"
import { reconcileSnapshot } from "./model.mjs"
import {
  createCloudflareProvider,
  createSupabaseProvider,
} from "./providers.mjs"
import {
  copyImageObjects,
  hydrateImageHashes,
  removeCopiedObjects,
} from "./storage.mjs"

const TARGET_SUPABASE_NAME = "task-roadmap"

function projectRef(project) {
  return project?.ref ?? project?.id
}

function projectRegion(project) {
  return project?.region
}

function ensureSuccessReport(report) {
  if (!report?.ok) {
    throw new Error(
      `目标数据核对失败（${report?.differences?.length ?? 0} 项）`,
    )
  }
  return report
}

export function validateTargetReadyAudit(audit, { expectedAuthEmails }) {
  const differences = []
  const add = (condition, message) => {
    if (!condition) differences.push(message)
  }
  add(Array.isArray(audit.projects) && audit.projects.length > 0, "目标项目数据为空")
  add(Array.isArray(audit.items) && audit.items.length > 0, "目标尚无复制条目")
  add(
    audit.items.every(
      (item) => String(item.voteCount) === String(item.voteBaseline),
    ),
    "目标公开票数不是历史基线",
  )
  add(audit.operationalCounts?.votes === 0, "目标 votes 必须为空")
  add(
    audit.operationalCounts?.suggestionRateLimits === 0,
    "目标 suggestion_rate_limits 必须为空",
  )
  add(
    audit.operationalCounts?.suggestionImageRateLimits === 0,
    "目标 suggestion_image_rate_limits 必须为空",
  )
  add(
    Number(audit.usedBytes) ===
      audit.images.reduce((total, image) => total + Number(image.sizeBytes), 0),
    "目标图片逻辑用量不一致",
  )
  add(
    audit.bucket?.public === false &&
      Number(audit.bucket?.fileSizeLimit) === 5_000_000 &&
      JSON.stringify([...(audit.bucket?.allowedMimeTypes ?? [])].sort()) ===
        JSON.stringify(["image/jpeg", "image/png"]),
    "目标图片 Bucket 配置不一致",
  )
  const actualEmails = audit.authUsers.map((user) => user.email).sort()
  add(
    JSON.stringify(actualEmails) ===
      JSON.stringify([...expectedAuthEmails].sort()),
    "目标 Auth 用户不符合预期",
  )
  return { ok: differences.length === 0, differences }
}

export async function copyTarget(context) {
  let manifest
  let uploadedPaths = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      manifest = await context.captureSnapshot()
      manifest = await context.hydrateHashes(manifest)
    } catch (error) {
      if (error?.code !== "SOURCE_SNAPSHOT_STALE" || attempt === 3) throw error
      continue
    }

    await context.assertFreshTarget()
    try {
      const copied = await context.copyObjects(manifest)
      uploadedPaths = copied.uploadedPaths
      break
    } catch (error) {
      if (error?.code !== "SOURCE_SNAPSHOT_STALE" || attempt === 3) throw error
      await context.cleanupObjects([])
    }
  }

  if (!manifest) throw new Error("无法获取稳定的源数据快照")
  let imported = false
  try {
    await context.importData(manifest)
    imported = true
    return ensureSuccessReport(await context.audit(manifest))
  } catch (error) {
    const cleanupErrors = []
    if (imported && context.cleanupImportedData) {
      try {
        await context.cleanupImportedData()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    try {
      await context.cleanupObjects(uploadedPaths)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${error.message}；目标清理失败（${cleanupErrors.length} 项）`,
      )
    }
    throw error
  }
}

export async function deployTarget(context) {
  await context.assertCopyReconciled()
  await context.configureAuth()
  await context.deployEdge()
  await context.deployPages()
  return ensureSuccessReport(await context.audit())
}

export async function domainTarget(context) {
  await context.assertStableSmoke()
  if (context.preflightDomain) await context.preflightDomain()
  return context.bindDomain()
}

async function loadSourceInputs() {
  const inputs = await readDeploymentInputs(".env.deploy.local")
  const errors = validateDeploymentInputs(inputs)
  if (errors.length > 0) {
    throw new Error(`源部署配置无效（${errors.length} 项）`)
  }
  return inputs
}

async function loadProviders(sourceInputs) {
  const supabase = createSupabaseProvider({
    accessToken: sourceInputs.SUPABASE_ACCESS_TOKEN,
    runCommand: runCaptured,
    workdir: process.cwd(),
  })
  const cloudflare = createCloudflareProvider({
    accountId: sourceInputs.CLOUDFLARE_ACCOUNT_ID,
    zoneId: sourceInputs.CLOUDFLARE_ZONE_ID,
    apiToken: sourceInputs.CLOUDFLARE_API_TOKEN,
    runCommand: runCaptured,
    workdir: process.cwd(),
  })
  return { supabase, cloudflare }
}

async function findProjectPair(supabase, sourceInputs, targetInputs = null) {
  const projects = await supabase.listProjects()
  const source = projects.find(
    (project) => projectRef(project) === sourceInputs.SUPABASE_PROJECT_REF,
  )
  if (!source) throw new Error("找不到源 Supabase 项目")
  const target = targetInputs
    ? projects.find(
        (project) => projectRef(project) === targetInputs.SUPABASE_PROJECT_REF,
      )
    : null
  if (targetInputs && !target) throw new Error("找不到目标 Supabase 项目")
  return { projects, source, target }
}

function queryFor(supabase, project, inputs) {
  return ({ projectRef: requestedRef, sql, operation }) => {
    if (requestedRef !== projectRef(project)) {
      throw new Error("数据库查询项目与已验证项目不匹配")
    }
    return supabase.queryDatabase({
      projectRef: requestedRef,
      region: projectRegion(project),
      databasePassword: inputs.SUPABASE_DB_PASSWORD,
      sql,
      operation,
    })
  }
}

async function prepareStage() {
  const sourceInputs = await loadSourceInputs()
  const { supabase } = await loadProviders(sourceInputs)
  const { projects, source } = await findProjectPair(supabase, sourceInputs)
  let targetInputs
  try {
    targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  let target
  if (targetInputs) {
    const errors = validateTaskIdentity(sourceInputs, targetInputs)
    if (errors.length > 0) throw new Error(`目标部署配置无效（${errors.length} 项）`)
    target = projects.find(
      (project) => projectRef(project) === targetInputs.SUPABASE_PROJECT_REF,
    )
    if (!target) throw new Error("目标配置对应的 Supabase 项目不存在")
  } else {
    const nameConflict = projects.find((project) => project.name === TARGET_SUPABASE_NAME)
    if (nameConflict) {
      throw new Error(
        `已存在未纳入本机配置的 ${TARGET_SUPABASE_NAME} 项目（Ref ${projectRef(nameConflict)}）`,
      )
    }
    const secrets = generateTargetSecrets()
    target = await supabase.createProject({
      name: TARGET_SUPABASE_NAME,
      organizationId: source.organization_id,
      region: projectRegion(source),
      databasePassword: secrets.databasePassword,
    })
    target = await supabase.waitProjectHealthy(projectRef(target))
    const apiKeys = await supabase.getApiKeys(projectRef(target))
    targetInputs = {
      ROADMAP_DOMAIN: TASK_DOMAIN,
      CLOUDFLARE_PAGES_PROJECT: TASK_PAGES_PROJECT,
      SUPABASE_PROJECT_REF: projectRef(target),
      SUPABASE_URL: `https://${projectRef(target)}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: apiKeys.publishableKey,
      SUPABASE_SECRET_KEY: apiKeys.secretKey,
      SUPABASE_DB_PASSWORD: secrets.databasePassword,
      ADMIN_EMAIL: TASK_ADMIN_EMAIL,
      ADMIN_PASSWORD: secrets.adminPassword,
      VOTE_IP_SALT: secrets.voteIpSalt,
    }
    const errors = validateTaskIdentity(sourceInputs, targetInputs)
    if (errors.length > 0) throw new Error(`生成的目标部署配置无效（${errors.length} 项）`)
    await writeTargetInputsAtomic(TASK_DEPLOYMENT_INPUTS_FILE, targetInputs)
  }

  await supabase.applyMigrations({
    projectRef: targetInputs.SUPABASE_PROJECT_REF,
    region: projectRegion(target),
    databasePassword: targetInputs.SUPABASE_DB_PASSWORD,
    dryRun: true,
  })
  await supabase.applyMigrations({
    projectRef: targetInputs.SUPABASE_PROJECT_REF,
    region: projectRegion(target),
    databasePassword: targetInputs.SUPABASE_DB_PASSWORD,
  })
  const audit = await auditTarget({
    query: queryFor(supabase, target, targetInputs),
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  const expectedSeed = ["advertising-system", "ks-alert", "template-tools", "other"]
  if (
    audit.items.length !== 0 ||
    audit.images.length !== 0 ||
    audit.authUsers.length !== 0 ||
    audit.usedBytes !== 0 ||
    JSON.stringify(audit.projects.map((project) => project.slug)) !==
      JSON.stringify(expectedSeed)
  ) {
    throw new Error("目标 Supabase 初始化状态不符合预期")
  }
  return { targetRef: targetInputs.SUPABASE_PROJECT_REF }
}

const RESET_TARGET_SQL = `begin;
select pg_advisory_xact_lock(hashtextextended('task-roadmap-clone-v1', 0));
delete from public.roadmap_item_images;
delete from public.roadmap_status_history;
delete from public.roadmap_items;
delete from public.projects;
insert into public.projects (name, slug, project_url, sort_order)
values
  ('广告系统', 'advertising-system', null, 0),
  ('ks-alert', 'ks-alert', null, 1),
  ('模板工具', 'template-tools', null, 2),
  ('其他', 'other', null, 3);
commit;`

async function copyStage() {
  const sourceInputs = await loadSourceInputs()
  const targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  const errors = validateTaskIdentity(sourceInputs, targetInputs)
  if (errors.length > 0) throw new Error(`目标部署配置无效（${errors.length} 项）`)
  const { supabase } = await loadProviders(sourceInputs)
  const { source, target } = await findProjectPair(
    supabase,
    sourceInputs,
    targetInputs,
  )
  const sourceQuery = queryFor(supabase, source, sourceInputs)
  const targetQuery = queryFor(supabase, target, targetInputs)
  return copyTarget({
    captureSnapshot: () =>
      captureSourceSnapshot({
        query: sourceQuery,
        sourceRef: sourceInputs.SUPABASE_PROJECT_REF,
      }),
    hydrateHashes: (manifest) =>
      hydrateImageHashes({
        manifest,
        source: {
          url: sourceInputs.SUPABASE_URL,
          secretKey: sourceInputs.SUPABASE_SECRET_KEY,
        },
      }),
    assertFreshTarget: async () => {
      const audit = await auditTarget({
        query: targetQuery,
        targetRef: targetInputs.SUPABASE_PROJECT_REF,
      })
      if (
        audit.items.length !== 0 ||
        audit.images.length !== 0 ||
        audit.authUsers.length !== 0 ||
        Object.values(audit.operationalCounts).some((count) => count !== 0)
      ) {
        throw new Error("目标项目已包含数据，拒绝再次复制")
      }
    },
    copyObjects: async (manifest) => {
      return copyImageObjects({
        manifest,
        source: {
          url: sourceInputs.SUPABASE_URL,
          secretKey: sourceInputs.SUPABASE_SECRET_KEY,
        },
        target: {
          url: targetInputs.SUPABASE_URL,
          secretKey: targetInputs.SUPABASE_SECRET_KEY,
        },
      })
    },
    importData: (manifest) =>
      importSnapshot({
        query: targetQuery,
        targetRef: targetInputs.SUPABASE_PROJECT_REF,
        manifest,
      }),
    audit: async (manifest) => {
      const audit = await auditTarget({
        query: targetQuery,
        targetRef: targetInputs.SUPABASE_PROJECT_REF,
      })
      const targetHashed = await hydrateImageHashes({
        manifest,
        source: {
          url: targetInputs.SUPABASE_URL,
          secretKey: targetInputs.SUPABASE_SECRET_KEY,
        },
      })
      audit.objectHashes = Object.fromEntries(
        targetHashed.images.map((image) => [image.storagePath, image.sha256]),
      )
      return reconcileSnapshot(manifest, audit, { expectedAuthUsers: 0 })
    },
    cleanupImportedData: () =>
      targetQuery({
        projectRef: targetInputs.SUPABASE_PROJECT_REF,
        sql: RESET_TARGET_SQL,
        operation: "清理失败的目标数据导入",
      }),
    cleanupObjects: (paths) =>
      removeCopiedObjects({
        paths,
        target: {
          url: targetInputs.SUPABASE_URL,
          secretKey: targetInputs.SUPABASE_SECRET_KEY,
        },
      }),
  })
}

async function targetReadyReport({ supabase, target, targetInputs, expectedAuthEmails }) {
  const targetQuery = queryFor(supabase, target, targetInputs)
  const audit = await auditTarget({
    query: targetQuery,
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  await hydrateImageHashes({
    manifest: { images: audit.images },
    source: {
      url: targetInputs.SUPABASE_URL,
      secretKey: targetInputs.SUPABASE_SECRET_KEY,
    },
  })
  return validateTargetReadyAudit(audit, { expectedAuthEmails })
}

async function deployStage() {
  const sourceInputs = await loadSourceInputs()
  const targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  const { supabase, cloudflare } = await loadProviders(sourceInputs)
  const { target } = await findProjectPair(supabase, sourceInputs, targetInputs)

  return deployTarget({
    assertCopyReconciled: async () =>
      ensureSuccessReport(
        await targetReadyReport({
          supabase,
          target,
          targetInputs,
          expectedAuthEmails: [],
        }),
      ),
    configureAuth: async () => {
      const users = await supabase.listAuthUsers({
        projectUrl: targetInputs.SUPABASE_URL,
        secretKey: targetInputs.SUPABASE_SECRET_KEY,
      })
      const existingAdmin =
        users.length === 1 && users[0].email === targetInputs.ADMIN_EMAIL
      if (users.length > 0 && !existingAdmin) {
        throw new Error("目标 Auth 已存在非预期用户")
      }
      await supabase.configureAuth({
        projectRef: targetInputs.SUPABASE_PROJECT_REF,
        projectUrl: targetInputs.SUPABASE_URL,
        secretKey: targetInputs.SUPABASE_SECRET_KEY,
        adminEmail: targetInputs.ADMIN_EMAIL,
        adminPassword: targetInputs.ADMIN_PASSWORD,
        createAdmin: !existingAdmin,
      })
    },
    deployEdge: async () => {
      await supabase.setEdgeSecrets({
        projectRef: targetInputs.SUPABASE_PROJECT_REF,
        voteIpSalt: targetInputs.VOTE_IP_SALT,
      })
      await supabase.deployEdgeFunctions(targetInputs.SUPABASE_PROJECT_REF)
    },
    deployPages: async () => {
      await cloudflare.ensurePagesProject()
      await cloudflare.configureRuntime({
        supabaseUrl: targetInputs.SUPABASE_URL,
        publishableKey: targetInputs.SUPABASE_PUBLISHABLE_KEY,
        secretKey: targetInputs.SUPABASE_SECRET_KEY,
      })
      const git = await runCaptured("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        operation: "读取部署提交",
      })
      await cloudflare.deployPages({
        buildEnv: {
          NEXT_PUBLIC_SUPABASE_URL: targetInputs.SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
            targetInputs.SUPABASE_PUBLISHABLE_KEY,
          NEXT_PUBLIC_ADMIN_EMAIL: targetInputs.ADMIN_EMAIL,
        },
        commitHash: git.stdout.trim(),
      })
    },
    audit: () =>
      targetReadyReport({
        supabase,
        target,
        targetInputs,
        expectedAuthEmails: [TASK_ADMIN_EMAIL],
      }),
  })
}

async function domainStage() {
  const sourceInputs = await loadSourceInputs()
  const { cloudflare } = await loadProviders(sourceInputs)
  await domainTarget({
    assertStableSmoke: async () => {
      for (const path of ["/", "/admin/"]) {
        const response = await fetch(`https://${TASK_PAGES_PROJECT}.pages.dev${path}`)
        if (!response.ok) throw new Error("稳定 Pages 域名尚未通过基础检查")
      }
    },
    bindDomain: () => cloudflare.bindDomain(),
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const domain = await cloudflare.getDomain()
    if (domain.status === "active") return domain
    if (["blocked", "error", "deactivated"].includes(domain.status)) {
      throw new Error(`Task Roadmap 域名状态异常：${domain.status}`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  throw new Error("等待 Task Roadmap 域名生效超时")
}

async function statusStage() {
  const sourceInputs = await loadSourceInputs()
  const targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  const errors = validateTaskIdentity(sourceInputs, targetInputs)
  if (errors.length > 0) throw new Error(`目标部署配置无效（${errors.length} 项）`)
  const { supabase } = await loadProviders(sourceInputs)
  const { target } = await findProjectPair(supabase, sourceInputs, targetInputs)
  const audit = await auditTarget({
    query: queryFor(supabase, target, targetInputs),
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  return {
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
    projects: audit.projects.length,
    items: audit.items.length,
    histories: audit.histories.length,
    images: audit.images.length,
    authUsers: audit.authUsers.length,
  }
}

export async function executeStage(stage) {
  if (stage === "prepare") return prepareStage()
  if (stage === "copy") return copyStage()
  if (stage === "deploy") return deployStage()
  if (stage === "domain") return domainStage()
  if (stage === "status") return statusStage()
  throw new Error("未知 Task Roadmap 部署阶段")
}

async function main() {
  const result = await executeStage(process.argv[2] ?? "status")
  const summary = Object.entries(result ?? {})
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  process.stdout.write(`Task Roadmap 阶段完成${summary ? `：${summary}` : ""}\n`)
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
