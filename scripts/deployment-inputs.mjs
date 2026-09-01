import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const DEPLOYMENT_INPUTS_FILE = ".env.deploy.local"

const REQUIRED_FIELDS = [
  "ROADMAP_DOMAIN",
  "ADVERTISING_SYSTEM_URL",
  "KS_ALERT_URL",
  "TEMPLATE_TOOLS_URL",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "ADMIN_PASSWORD",
  "VOTE_IP_SALT",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_PAGES_PROJECT",
]

function isPlaceholder(value) {
  return !value || /^(?:请填写|待填写|TODO|CHANGE_ME|<.+>)$/i.test(value.trim())
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

export function parseDeploymentInputs(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=")
        if (separator < 1) return null
        const key = line.slice(0, separator).trim()
        const rawValue = line.slice(separator + 1).trim()
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return null
        if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
          return [key, JSON.parse(rawValue)]
        }
        return [key, rawValue]
      })
      .filter(Boolean),
  )
}

export async function readDeploymentInputs(path = DEPLOYMENT_INPUTS_FILE) {
  return parseDeploymentInputs(
    await readFile(resolve(process.cwd(), path), "utf8"),
  )
}

export function validateDeploymentInputs(inputs) {
  const errors = []
  const missing = new Set(
    REQUIRED_FIELDS.filter((field) => isPlaceholder(inputs[field])),
  )

  for (const field of REQUIRED_FIELDS) {
    if (missing.has(field)) errors.push(`${field}：未填写`)
  }

  const validate = (field, condition, message) => {
    if (!missing.has(field) && !condition) errors.push(`${field}：${message}`)
  }

  validate(
    "ROADMAP_DOMAIN",
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(inputs.ROADMAP_DOMAIN),
    "应只填写域名，不含协议、路径或端口",
  )
  for (const field of ["ADVERTISING_SYSTEM_URL", "KS_ALERT_URL", "TEMPLATE_TOOLS_URL"]) {
    validate(field, isHttpsUrl(inputs[field]), "必须是有效的 https:// 网址")
  }
  validate(
    "SUPABASE_PROJECT_REF",
    /^[a-z0-9]{20}$/.test(inputs.SUPABASE_PROJECT_REF),
    "格式无效",
  )
  validate(
    "SUPABASE_URL",
    inputs.SUPABASE_URL?.replace(/\/$/, "") ===
      `https://${inputs.SUPABASE_PROJECT_REF}.supabase.co`,
    "必须与 Project Ref 对应",
  )
  validate(
    "SUPABASE_PUBLISHABLE_KEY",
    /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(inputs.SUPABASE_PUBLISHABLE_KEY),
    "应使用 sb_publishable_ 开头的密钥",
  )
  validate(
    "SUPABASE_SECRET_KEY",
    /^sb_secret_[A-Za-z0-9_-]{20,}$/.test(inputs.SUPABASE_SECRET_KEY),
    "应使用 sb_secret_ 开头的密钥",
  )
  validate(
    "SUPABASE_ACCESS_TOKEN",
    /^sbp_[A-Za-z0-9_-]{20,}$/.test(inputs.SUPABASE_ACCESS_TOKEN),
    "应使用 sbp_ 开头的访问令牌",
  )
  validate(
    "SUPABASE_DB_PASSWORD",
    inputs.SUPABASE_DB_PASSWORD?.length >= 12,
    "至少需要 12 个字符",
  )
  validate(
    "ADMIN_PASSWORD",
    inputs.ADMIN_PASSWORD?.length >= 32 &&
      /[A-Z]/.test(inputs.ADMIN_PASSWORD) &&
      /[a-z]/.test(inputs.ADMIN_PASSWORD) &&
      /\d/.test(inputs.ADMIN_PASSWORD) &&
      /[^A-Za-z0-9]/.test(inputs.ADMIN_PASSWORD),
    "至少 32 位，并包含大小写字母、数字和特殊字符",
  )
  validate(
    "VOTE_IP_SALT",
    /^[a-f0-9]{64}$/i.test(inputs.VOTE_IP_SALT),
    "必须是 64 位十六进制随机值",
  )
  for (const field of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID"]) {
    validate(field, /^[a-f0-9]{32}$/i.test(inputs[field]), "必须是 32 位十六进制 ID")
  }
  validate(
    "CLOUDFLARE_API_TOKEN",
    /^[A-Za-z0-9_-]{30,}$/.test(inputs.CLOUDFLARE_API_TOKEN),
    "格式无效",
  )
  validate(
    "CLOUDFLARE_PAGES_PROJECT",
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(inputs.CLOUDFLARE_PAGES_PROJECT),
    "只能包含小写字母、数字和连字符",
  )

  return errors
}

async function main() {
  let inputs
  try {
    inputs = await readDeploymentInputs()
  } catch (error) {
    const message = error?.code === "ENOENT"
      ? `找不到 ${DEPLOYMENT_INPUTS_FILE}`
      : `无法读取 ${DEPLOYMENT_INPUTS_FILE}`
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
    return
  }

  const errors = validateDeploymentInputs(inputs)
  if (errors.length) {
    process.stderr.write(`部署配置尚未完成（${errors.length} 项）：\n`)
    for (const error of errors) process.stderr.write(`- ${error}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write("部署配置完整：16 项检查通过，未输出任何配置值。\n")
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ""
if (entryPoint === import.meta.url) {
  main().catch(() => {
    process.stderr.write("部署配置检查失败\n")
    process.exitCode = 1
  })
}
