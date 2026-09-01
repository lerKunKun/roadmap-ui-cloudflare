import { randomBytes as secureRandomBytes } from "node:crypto"
import { open, readFile, rename, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { parseDeploymentInputs } from "../deployment-inputs.mjs"

export const TASK_DEPLOYMENT_INPUTS_FILE = ".env.task.deploy.local"
export const TASK_DOMAIN = "task.telljax.com"
export const TASK_PAGES_PROJECT = "task-roadmap-ui"
export const TASK_ADMIN_EMAIL = "roadmap-admin@internal.invalid"

const TARGET_FIELDS = [
  "ROADMAP_DOMAIN",
  "CLOUDFLARE_PAGES_PROJECT",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_DB_PASSWORD",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "VOTE_IP_SALT",
]

function strongPassword(randomBytes) {
  return `Aa1!${randomBytes(24).toString("base64url")}`
}

export function generateTargetSecrets(randomBytes = secureRandomBytes) {
  return {
    databasePassword: strongPassword(randomBytes),
    adminPassword: strongPassword(randomBytes),
    voteIpSalt: randomBytes(32).toString("hex"),
  }
}

export function parseTaskInputs(source) {
  return parseDeploymentInputs(source)
}

function isStrongPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  )
}

export function validateTaskIdentity(source, target) {
  const errors = []
  const add = (field, condition, message) => {
    if (!condition) errors.push(`${field}：${message}`)
  }

  add("ROADMAP_DOMAIN", target.ROADMAP_DOMAIN === TASK_DOMAIN, `必须是 ${TASK_DOMAIN}`)
  add(
    "CLOUDFLARE_PAGES_PROJECT",
    target.CLOUDFLARE_PAGES_PROJECT === TASK_PAGES_PROJECT,
    `必须是 ${TASK_PAGES_PROJECT}`,
  )
  add(
    "SUPABASE_PROJECT_REF",
    /^[a-z0-9]{20}$/.test(target.SUPABASE_PROJECT_REF ?? ""),
    "格式无效",
  )
  if (target.SUPABASE_PROJECT_REF === source.SUPABASE_PROJECT_REF) {
    errors.push("SUPABASE_PROJECT_REF：必须与源项目不同")
  }
  add(
    "SUPABASE_URL",
    target.SUPABASE_URL ===
      `https://${target.SUPABASE_PROJECT_REF}.supabase.co`,
    "必须与目标 Project Ref 对应",
  )
  add(
    "SUPABASE_PUBLISHABLE_KEY",
    /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(
      target.SUPABASE_PUBLISHABLE_KEY ?? "",
    ),
    "格式无效",
  )
  add(
    "SUPABASE_SECRET_KEY",
    /^sb_secret_[A-Za-z0-9_-]{20,}$/.test(target.SUPABASE_SECRET_KEY ?? ""),
    "格式无效",
  )
  add(
    "SUPABASE_DB_PASSWORD",
    isStrongPassword(target.SUPABASE_DB_PASSWORD),
    "至少 32 位，并包含大小写字母、数字和特殊字符",
  )
  add(
    "ADMIN_EMAIL",
    target.ADMIN_EMAIL === TASK_ADMIN_EMAIL,
    `必须是 ${TASK_ADMIN_EMAIL}`,
  )
  add(
    "ADMIN_PASSWORD",
    isStrongPassword(target.ADMIN_PASSWORD),
    "至少 32 位，并包含大小写字母、数字和特殊字符",
  )
  add(
    "VOTE_IP_SALT",
    /^[a-f0-9]{64}$/.test(target.VOTE_IP_SALT ?? ""),
    "必须是 64 位小写十六进制随机值",
  )
  if (target.VOTE_IP_SALT === source.VOTE_IP_SALT) {
    errors.push("VOTE_IP_SALT：必须与源实例不同")
  }
  for (const field of [
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_DB_PASSWORD",
    "ADMIN_PASSWORD",
  ]) {
    if (source[field] && target[field] === source[field]) {
      errors.push(`${field}：必须与源实例不同`)
    }
  }

  return errors
}

export function assertTaskIdentity(source, target) {
  const errors = validateTaskIdentity(source, target)
  if (errors.length > 0) {
    throw new Error(`目标部署配置无效（${errors.length} 项）：${errors.join("；")}`)
  }
  return target
}

function serializeTaskInputs(values) {
  return `${TARGET_FIELDS.map((field) => {
    if (!(field in values)) throw new Error(`目标配置缺少字段：${field}`)
    return `${field}=${JSON.stringify(String(values[field]))}`
  }).join("\n")}\n`
}

export async function readTaskInputs(path = TASK_DEPLOYMENT_INPUTS_FILE) {
  return parseTaskInputs(await readFile(resolve(process.cwd(), path), "utf8"))
}

export async function writeTargetInputsAtomic(path, values, options = {}) {
  const destination = resolve(path)
  let existing = null
  try {
    existing = parseTaskInputs(await readFile(destination, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  if (existing) {
    if (
      !options.expectedProjectRef ||
      existing.SUPABASE_PROJECT_REF !== options.expectedProjectRef
    ) {
      throw new Error("目标配置属于其他 Supabase 项目")
    }
  }

  const temporary = resolve(
    dirname(destination),
    `.${process.pid}-${secureRandomBytes(6).toString("hex")}.tmp`,
  )
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(serializeTaskInputs(values), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
