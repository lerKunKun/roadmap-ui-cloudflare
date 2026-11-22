import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  readDeploymentInputs,
  validateDeploymentInputs,
} from "../deployment-inputs.mjs"
import {
  auditTarget,
  buildTargetCloneInfrastructureSql,
  captureSourceSnapshot,
  importSnapshot,
} from "./database.mjs"
import { runCaptured } from "./command.mjs"
import {
  TASK_ADMIN_EMAIL,
  TASK_DEPLOYMENT_INPUTS_FILE,
  TASK_DOMAIN,
  TASK_PAGES_PROJECT,
  assertTaskIdentity,
  generateTargetSecrets,
  readTaskInputs,
  validateTaskIdentity,
  writeTargetInputsAtomic,
} from "./config.mjs"
import { reconcileSnapshot } from "./model.mjs"
import {
  TASK_COPY_RECEIPT_FILE,
  TASK_AMBIGUITY_RECEIPT_FILE,
  TASK_SMOKE_RECEIPT_FILE,
  createCopyReceipt,
  datasetDigests,
  objectDigest,
  readCopyReceipt,
  readOptionalCopyReceipt,
  readSmokeReceipt,
  removeReceipt,
  writeReceiptAtomic,
} from "./receipts.mjs"
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
    const details = Array.isArray(report?.differences)
      ? `：${report.differences.join("；")}`
      : ""
    throw new Error(
      `目标数据核对失败（${report?.differences?.length ?? 0} 项）${details}`
    )
  }
  return report
}

export function validateStageReceipts(
  stage,
  {
    sourceRef,
    targetRef,
    commit,
    copyReceipt,
    smokeReceipt = /** @type {Record<string, any> | null} */ (null),
  }
) {
  if (
    copyReceipt?.sourceProjectRef !== sourceRef ||
    copyReceipt?.targetProjectRef !== targetRef ||
    copyReceipt?.appCommit !== commit
  ) {
    throw new Error("复制回执与当前源、目标或提交不匹配")
  }
  if (stage === "deploy") return true
  const expectedBaseUrl =
    stage === "domain"
      ? `https://${TASK_PAGES_PROJECT}.pages.dev/`
      : stage === "status"
        ? `https://${TASK_DOMAIN}/`
        : null
  if (!expectedBaseUrl) throw new Error("回执校验阶段无效")
  if (
    smokeReceipt?.baseUrl !== expectedBaseUrl ||
    smokeReceipt?.targetProjectRef !== targetRef ||
    smokeReceipt?.copyDigest !== copyReceipt.manifestDigest ||
    smokeReceipt?.appCommit !== commit
  ) {
    throw new Error(
      stage === "status"
        ? "最终域名冒烟回执与当前部署不匹配"
        : "稳定 Pages 冒烟回执与当前部署不匹配"
    )
  }
  return true
}

/**
 * @param {Record<string, any>} audit
 * @param {{ expectedAuthEmails: string[], alternativeAuthEmailSets?: string[][] }} options
 */
export function validateTargetReadyAudit(
  audit,
  { expectedAuthEmails, alternativeAuthEmailSets = [] }
) {
  const differences = []
  const add = (condition, message) => {
    if (!condition) differences.push(message)
  }
  add(
    Array.isArray(audit.projects) && audit.projects.length > 0,
    "目标项目数据为空"
  )
  add(Array.isArray(audit.items) && audit.items.length > 0, "目标尚无复制条目")
  add(
    audit.items.every(
      (item) => String(item.voteCount) === String(item.voteBaseline)
    ),
    "目标公开票数不是历史基线"
  )
  add(audit.operationalCounts?.votes === 0, "目标 votes 必须为空")
  add(
    audit.operationalCounts?.suggestionRateLimits === 0,
    "目标 suggestion_rate_limits 必须为空"
  )
  add(
    audit.operationalCounts?.suggestionImageRateLimits === 0,
    "目标 suggestion_image_rate_limits 必须为空"
  )
  add(
    Number(audit.usedBytes) ===
      audit.images.reduce((total, image) => total + Number(image.sizeBytes), 0),
    "目标图片逻辑用量不一致"
  )
  const imagePaths = audit.images.map((image) => image.storagePath).sort()
  const objectPaths = (audit.storageObjects ?? [])
    .map((object) => object.name)
    .sort()
  add(
    JSON.stringify(imagePaths) === JSON.stringify(objectPaths),
    "图片对象路径不一致"
  )
  const imageObjectMetadata = audit.images
    .map((image) => ({
      name: image.storagePath,
      sizeBytes: Number(image.sizeBytes),
      mimeType: image.mimeType,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const storageObjectMetadata = (audit.storageObjects ?? [])
    .map((object) => ({
      name: object.name,
      sizeBytes: Number(object.sizeBytes),
      mimeType: object.mimeType,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  add(
    JSON.stringify(imageObjectMetadata) ===
      JSON.stringify(storageObjectMetadata),
    "图片对象元数据不一致"
  )
  add(
    audit.bucket?.public === false &&
      Number(audit.bucket?.fileSizeLimit) === 5_000_000 &&
      JSON.stringify([...(audit.bucket?.allowedMimeTypes ?? [])].sort()) ===
        JSON.stringify(["image/jpeg", "image/png"]),
    "目标图片 Bucket 配置不一致"
  )
  const actualEmails = audit.authUsers.map((user) => user.email).sort()
  add(
    [expectedAuthEmails, ...alternativeAuthEmailSets].some(
      (emails) =>
        JSON.stringify(actualEmails) === JSON.stringify([...emails].sort())
    ),
    "目标 Auth 用户不符合预期"
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
  let receipt = null
  let imported = false
  try {
    receipt = context.prepareImport
      ? await context.prepareImport(manifest)
      : null
    try {
      await context.importData(manifest, receipt)
    } catch (error) {
      let outcome = "unknown"
      try {
        if (context.confirmImport)
          outcome = await context.confirmImport(receipt)
      } catch {
        outcome = "unknown"
      }
      if (outcome === "committed") {
        imported = true
      } else if (outcome === "unknown") {
        const ambiguityError = Object.assign(
          new Error("目标数据库提交结果不明，已保留对象并写入待确认回执"),
          { code: "IMPORT_COMMIT_UNKNOWN", cause: error }
        )
        try {
          if (context.persistAmbiguityReceipt) {
            await context.persistAmbiguityReceipt(receipt)
          }
        } catch (receiptError) {
          throw Object.assign(
            new AggregateError(
              [ambiguityError, receiptError],
              "目标数据库提交结果不明，且待确认回执写入失败"
            ),
            { code: "IMPORT_COMMIT_UNKNOWN" }
          )
        }
        throw ambiguityError
      } else {
        throw error
      }
    }
    imported = true
    const report = ensureSuccessReport(await context.audit(manifest, receipt))
    if (context.persistCopyReceipt) {
      await context.persistCopyReceipt(receipt, report)
    }
    return report
  } catch (error) {
    if (error?.code === "IMPORT_COMMIT_UNKNOWN") throw error
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
        `${error.message}；目标清理失败（${cleanupErrors.length} 项）`
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
    protectedProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
    protectedSecretKey: sourceInputs.SUPABASE_SECRET_KEY,
    runCommand: runCaptured,
    workdir: process.cwd(),
  })
  const cloudflare = createCloudflareProvider({
    accountId: sourceInputs.CLOUDFLARE_ACCOUNT_ID,
    zoneId: sourceInputs.CLOUDFLARE_ZONE_ID,
    apiToken: sourceInputs.CLOUDFLARE_API_TOKEN,
    protectedPagesProject: sourceInputs.CLOUDFLARE_PAGES_PROJECT,
    protectedSupabaseProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
    protectedSupabasePublishableKey: sourceInputs.SUPABASE_PUBLISHABLE_KEY,
    protectedSupabaseSecretKey: sourceInputs.SUPABASE_SECRET_KEY,
    runCommand: runCaptured,
    workdir: process.cwd(),
  })
  return { supabase, cloudflare }
}

async function findProjectPair(supabase, sourceInputs, targetInputs = null) {
  const projects = await supabase.listProjects()
  const source = projects.find(
    (project) => projectRef(project) === sourceInputs.SUPABASE_PROJECT_REF
  )
  if (!source) throw new Error("找不到源 Supabase 项目")
  const target = targetInputs
    ? projects.find(
        (project) => projectRef(project) === targetInputs.SUPABASE_PROJECT_REF
      )
    : null
  if (targetInputs && !target) throw new Error("找不到目标 Supabase 项目")
  return { projects, source, target }
}

function queryFor(supabase, project, inputs, { readOnly = false } = {}) {
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
      readOnly,
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
    if (errors.length > 0)
      throw new Error(`目标部署配置无效（${errors.length} 项）`)
    target = projects.find(
      (project) => projectRef(project) === targetInputs.SUPABASE_PROJECT_REF
    )
    if (!target) throw new Error("目标配置对应的 Supabase 项目不存在")
  } else {
    const nameConflict = projects.find(
      (project) => project.name === TARGET_SUPABASE_NAME
    )
    if (nameConflict) {
      throw new Error(
        `已存在未纳入本机配置的 ${TARGET_SUPABASE_NAME} 项目（Ref ${projectRef(nameConflict)}）`
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
      ADVERTISING_SYNC_CRON_SECRET: secrets.advertisingSyncCronSecret,
    }
    const errors = validateTaskIdentity(sourceInputs, targetInputs)
    if (errors.length > 0)
      throw new Error(`生成的目标部署配置无效（${errors.length} 项）`)
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
  await queryFor(
    supabase,
    target,
    targetInputs
  )({
    projectRef: targetInputs.SUPABASE_PROJECT_REF,
    sql: buildTargetCloneInfrastructureSql(targetInputs.SUPABASE_PROJECT_REF),
    operation: "初始化目标专用复制标记",
  })
  const audit = await auditTarget({
    query: queryFor(supabase, target, targetInputs),
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  const expectedSeed = [
    "advertising-system",
    "ks-alert",
    "template-tools",
    "other",
  ]
  if (
    audit.items.length !== 0 ||
    audit.images.length !== 0 ||
    audit.storageObjects.length !== 0 ||
    audit.authUsers.length !== 0 ||
    audit.cloneImportMarker !== null ||
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
delete from public.roadmap_clone_import_markers;
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
  if (errors.length > 0)
    throw new Error(`目标部署配置无效（${errors.length} 项）`)
  const { supabase } = await loadProviders(sourceInputs)
  const { source, target } = await findProjectPair(
    supabase,
    sourceInputs,
    targetInputs
  )
  const sourceQuery = queryFor(supabase, source, sourceInputs, {
    readOnly: true,
  })
  const targetQuery = queryFor(supabase, target, targetInputs)
  const ambiguityReceipt = await readOptionalCopyReceipt(
    TASK_AMBIGUITY_RECEIPT_FILE
  )
  if (ambiguityReceipt) {
    const git = await runCaptured("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      operation: "读取待确认复制提交",
    })
    if (
      ambiguityReceipt.sourceProjectRef !== sourceInputs.SUPABASE_PROJECT_REF ||
      ambiguityReceipt.targetProjectRef !== targetInputs.SUPABASE_PROJECT_REF ||
      ambiguityReceipt.appCommit !== git.stdout.trim()
    ) {
      throw new Error("待确认复制回执与当前源、目标或提交不匹配")
    }
    const audit = await auditTarget({
      query: targetQuery,
      targetRef: targetInputs.SUPABASE_PROJECT_REF,
    })
    if (
      audit.cloneImportMarker?.manifestDigest ===
      ambiguityReceipt.manifestDigest
    ) {
      const report = ensureSuccessReport(
        await targetReadyReport({
          supabase,
          target,
          targetInputs,
          expectedAuthEmails: [],
          copyReceipt: ambiguityReceipt,
        })
      )
      await writeReceiptAtomic(TASK_COPY_RECEIPT_FILE, ambiguityReceipt)
      await removeReceipt(TASK_AMBIGUITY_RECEIPT_FILE)
      return report
    }
    if (audit.cloneImportMarker !== null) {
      throw new Error("目标数据库存在与待确认回执不一致的复制标记")
    }
    const actualPaths = audit.storageObjects.map((object) => object.name).sort()
    const expectedPaths = ambiguityReceipt.objects
      .map((object) => object.storagePath)
      .sort()
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error("待确认复制对象集合不一致，拒绝自动清理")
    }
    await removeCopiedObjects({
      paths: expectedPaths,
      target: {
        url: targetInputs.SUPABASE_URL,
        secretKey: targetInputs.SUPABASE_SECRET_KEY,
      },
      protectedSource: {
        url: sourceInputs.SUPABASE_URL,
        secretKey: sourceInputs.SUPABASE_SECRET_KEY,
      },
    })
    await removeReceipt(TASK_AMBIGUITY_RECEIPT_FILE)
  }
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
        expectedProjectRef: sourceInputs.SUPABASE_PROJECT_REF,
      }),
    assertFreshTarget: async () => {
      const audit = await auditTarget({
        query: targetQuery,
        targetRef: targetInputs.SUPABASE_PROJECT_REF,
      })
      if (
        audit.items.length !== 0 ||
        audit.images.length !== 0 ||
        audit.storageObjects.length !== 0 ||
        audit.authUsers.length !== 0 ||
        audit.cloneImportMarker !== null ||
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
    prepareImport: async (manifest) => {
      const git = await runCaptured("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        operation: "读取复制提交",
      })
      return createCopyReceipt({
        manifest,
        targetProjectRef: targetInputs.SUPABASE_PROJECT_REF,
        appCommit: git.stdout.trim(),
      })
    },
    importData: (manifest, receipt) =>
      importSnapshot({
        query: targetQuery,
        targetRef: targetInputs.SUPABASE_PROJECT_REF,
        manifest,
        receipt,
      }),
    confirmImport: async (receipt) => {
      try {
        const audit = await auditTarget({
          query: targetQuery,
          targetRef: targetInputs.SUPABASE_PROJECT_REF,
        })
        return audit.cloneImportMarker?.manifestDigest ===
          receipt?.manifestDigest &&
          audit.cloneImportMarker?.targetProjectRef ===
            receipt?.targetProjectRef
          ? "committed"
          : audit.cloneImportMarker === null
            ? "rolled-back"
            : "unknown"
      } catch {
        return "unknown"
      }
    },
    audit: async (manifest, receipt) => {
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
        expectedProjectRef: targetInputs.SUPABASE_PROJECT_REF,
      })
      audit.objectHashes = Object.fromEntries(
        targetHashed.images.map((image) => [image.storagePath, image.sha256])
      )
      return reconcileSnapshot(manifest, audit, {
        expectedAuthUsers: 0,
        copyReceipt: receipt,
      })
    },
    persistCopyReceipt: (receipt) =>
      writeReceiptAtomic(TASK_COPY_RECEIPT_FILE, receipt),
    persistAmbiguityReceipt: (receipt) =>
      writeReceiptAtomic(TASK_AMBIGUITY_RECEIPT_FILE, receipt),
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
        protectedSource: {
          url: sourceInputs.SUPABASE_URL,
          secretKey: sourceInputs.SUPABASE_SECRET_KEY,
        },
      }),
  })
}

async function targetReadyReport({
  supabase,
  target,
  targetInputs,
  expectedAuthEmails,
  alternativeAuthEmailSets,
  copyReceipt,
}) {
  const targetQuery = queryFor(supabase, target, targetInputs)
  const audit = await auditTarget({
    query: targetQuery,
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  const targetHashed = await hydrateImageHashes({
    manifest: { images: audit.images },
    source: {
      url: targetInputs.SUPABASE_URL,
      secretKey: targetInputs.SUPABASE_SECRET_KEY,
    },
    expectedProjectRef: targetInputs.SUPABASE_PROJECT_REF,
  })
  const report = validateTargetReadyAudit(audit, {
    expectedAuthEmails,
    alternativeAuthEmailSets,
  })
  const add = (condition, message) => {
    if (!condition) report.differences.push(message)
  }
  add(
    audit.cloneImportMarker?.sourceProjectRef ===
      copyReceipt.sourceProjectRef &&
      audit.cloneImportMarker?.targetProjectRef ===
        copyReceipt.targetProjectRef &&
      audit.cloneImportMarker?.manifestDigest === copyReceipt.manifestDigest &&
      audit.cloneImportMarker?.objectDigest === copyReceipt.objectDigest &&
      audit.cloneImportMarker?.appCommit === copyReceipt.appCommit &&
      new Date(audit.cloneImportMarker?.capturedAt).toISOString() ===
        new Date(copyReceipt.capturedAt).toISOString() &&
      ["projects", "items", "histories", "images"].every(
        (field) =>
          Number(audit.cloneImportMarker?.counts?.[field]) ===
          copyReceipt.counts[field]
      ) &&
      ["projects", "items", "histories", "images", "objects"].every(
        (field) =>
          audit.cloneImportMarker?.datasetDigests?.[field] ===
          copyReceipt.datasetDigests[field]
      ),
    "数据库复制标记与本机回执不一致"
  )
  add(
    objectDigest(targetHashed.images) === copyReceipt.objectDigest,
    "目标图片对象内容与复制回执不一致"
  )
  const objectHashes = Object.fromEntries(
    targetHashed.images.map((image) => [image.storagePath, image.sha256])
  )
  const currentDigests = datasetDigests(
    {
      ...audit,
      images: targetHashed.images,
    },
    objectHashes
  )
  add(
    ["projects", "items", "histories", "images", "objects"].every(
      (field) => currentDigests[field] === copyReceipt.datasetDigests[field]
    ),
    "目标关系数据或对象摘要与复制回执不一致"
  )
  add(
    audit.projects.length === copyReceipt.counts.projects &&
      audit.items.length === copyReceipt.counts.items &&
      audit.histories.length === copyReceipt.counts.histories &&
      audit.images.length === copyReceipt.counts.images,
    "目标数据数量与复制回执不一致"
  )
  report.ok = report.differences.length === 0
  return report
}

async function deployStage() {
  const sourceInputs = await loadSourceInputs()
  const targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  assertTaskIdentity(sourceInputs, targetInputs)
  const copyReceipt = await readCopyReceipt(TASK_COPY_RECEIPT_FILE)
  const git = await runCaptured("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    operation: "读取部署提交",
  })
  validateStageReceipts("deploy", {
    sourceRef: sourceInputs.SUPABASE_PROJECT_REF,
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
    commit: git.stdout.trim(),
    copyReceipt,
  })
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
          alternativeAuthEmailSets: [[TASK_ADMIN_EMAIL]],
          copyReceipt,
        })
      ),
    configureAuth: async () => {
      await supabase.configureAuth({
        projectRef: targetInputs.SUPABASE_PROJECT_REF,
        projectUrl: targetInputs.SUPABASE_URL,
        secretKey: targetInputs.SUPABASE_SECRET_KEY,
        adminEmail: targetInputs.ADMIN_EMAIL,
        adminPassword: targetInputs.ADMIN_PASSWORD,
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
      await cloudflare.deployPages({
        buildEnv: {
          NEXT_PUBLIC_SUPABASE_URL: targetInputs.SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
            targetInputs.SUPABASE_PUBLISHABLE_KEY,
          NEXT_PUBLIC_ADMIN_EMAIL: targetInputs.ADMIN_EMAIL,
          NEXT_PUBLIC_ADVERTISING_REPLY_SOURCE_URL: sourceInputs.SUPABASE_URL,
          NEXT_PUBLIC_ADVERTISING_REPLY_SOURCE_KEY: sourceInputs.SUPABASE_PUBLISHABLE_KEY,
          NEXT_PUBLIC_DEPLOY_COMMIT: git.stdout.trim(),
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
        copyReceipt,
      }),
  })
}

async function domainStage() {
  const sourceInputs = await loadSourceInputs()
  const targetInputs = await readTaskInputs(TASK_DEPLOYMENT_INPUTS_FILE)
  assertTaskIdentity(sourceInputs, targetInputs)
  const [copyReceipt, smokeReceipt] = await Promise.all([
    readCopyReceipt(TASK_COPY_RECEIPT_FILE),
    readSmokeReceipt(TASK_SMOKE_RECEIPT_FILE),
  ])
  const git = await runCaptured("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    operation: "读取域名绑定提交",
  })
  validateStageReceipts("domain", {
    sourceRef: sourceInputs.SUPABASE_PROJECT_REF,
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
    commit: git.stdout.trim(),
    copyReceipt,
    smokeReceipt,
  })
  const { supabase, cloudflare } = await loadProviders(sourceInputs)
  const { target } = await findProjectPair(supabase, sourceInputs, targetInputs)
  ensureSuccessReport(
    await targetReadyReport({
      supabase,
      target,
      targetInputs,
      expectedAuthEmails: [TASK_ADMIN_EMAIL],
      copyReceipt,
    })
  )
  await domainTarget({
    assertStableSmoke: async () => {},
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
  if (errors.length > 0)
    throw new Error(`目标部署配置无效（${errors.length} 项）`)
  const { supabase } = await loadProviders(sourceInputs)
  const { target } = await findProjectPair(supabase, sourceInputs, targetInputs)
  const [copyReceipt, smokeReceipt] = await Promise.all([
    readCopyReceipt(TASK_COPY_RECEIPT_FILE),
    readSmokeReceipt(TASK_SMOKE_RECEIPT_FILE),
  ])
  const git = await runCaptured("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    operation: "读取核对提交",
  })
  validateStageReceipts("status", {
    sourceRef: sourceInputs.SUPABASE_PROJECT_REF,
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
    commit: git.stdout.trim(),
    copyReceipt,
    smokeReceipt,
  })
  const report = ensureSuccessReport(
    await targetReadyReport({
      supabase,
      target,
      targetInputs,
      expectedAuthEmails: [TASK_ADMIN_EMAIL],
      copyReceipt,
    })
  )
  const authConfig = await supabase.getAuthConfig(
    targetInputs.SUPABASE_PROJECT_REF
  )
  if (
    authConfig?.disable_signup !== true ||
    authConfig?.site_url !== `https://${TASK_DOMAIN}`
  ) {
    throw new Error("目标 Auth 配置未达到上线状态")
  }
  return {
    targetRef: targetInputs.SUPABASE_PROJECT_REF,
    projects: report.counts?.projects ?? copyReceipt.counts.projects,
    items: report.counts?.items ?? copyReceipt.counts.items,
    histories: report.counts?.histories ?? copyReceipt.counts.histories,
    images: report.counts?.images ?? copyReceipt.counts.images,
    authUsers: 1,
    ready: true,
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
    .filter(([, value]) =>
      ["string", "number", "boolean"].includes(typeof value)
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")
  process.stdout.write(
    `Task Roadmap 阶段完成${summary ? `：${summary}` : ""}\n`
  )
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
