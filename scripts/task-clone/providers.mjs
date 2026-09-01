import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SUPABASE_API = "https://api.supabase.com/v1"
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const TARGET_DOMAIN = "task.telljax.com"
const TARGET_PAGES_PROJECT = "task-roadmap-ui"
const NPX = process.platform === "win32" ? "npx.cmd" : "npx"

class ProviderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "ProviderError"
    this.code = code
  }
}

async function responseJson(response, provider, allowNotFound = false) {
  if (allowNotFound && response.status === 404) return null
  let value = null
  try {
    value = await response.json()
  } catch {
    value = null
  }
  if (!response.ok || (provider === "Cloudflare" && value?.success !== true)) {
    const requestId =
      response.headers.get("cf-ray") ?? response.headers.get("x-request-id")
    throw new ProviderError(
      `${provider.toUpperCase()}_REQUEST_FAILED`,
      `${provider} 请求失败（HTTP ${response.status}${requestId ? `，请求 ${requestId}` : ""}）`,
    )
  }
  return provider === "Cloudflare" ? value.result : value
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, result))
  else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => collectStrings(entry, result))
  }
  return result
}

function parseCommandJson(stdout, message) {
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(message)
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    throw new Error(message)
  }
}

function databaseUrl({ projectRef, region, databasePassword }) {
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(databasePassword)}@aws-0-${region}.pooler.supabase.com:5432/postgres?sslmode=require`
}

export function createSupabaseProvider({
  accessToken,
  runCommand,
  fetchImpl = fetch,
  workdir = process.cwd(),
}) {
  const commandEnv = { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken }
  const managementHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "User-Agent": "task-roadmap-clone/1.0",
  }

  async function listProjects() {
    const result = await runCommand(
      NPX,
      ["supabase", "projects", "list", "--output-format", "json"],
      { cwd: workdir, env: commandEnv, operation: "读取 Supabase 项目列表" },
    )
    const parsed = parseCommandJson(result.stdout, "Supabase 项目列表结果无效")
    const projects = Array.isArray(parsed) ? parsed : parsed.projects
    if (!Array.isArray(projects)) throw new Error("Supabase 项目列表结果无效")
    return projects
  }

  async function createProject({ name, organizationId, region, databasePassword }) {
    const result = await runCommand(
      NPX,
      [
        "supabase",
        "projects",
        "create",
        name,
        "--org-id",
        organizationId,
        "--db-password",
        databasePassword,
        "--region",
        region,
        "--size",
        "micro",
        "--output-format",
        "json",
      ],
      { cwd: workdir, env: commandEnv, operation: "创建目标 Supabase 项目" },
    )
    const parsed = parseCommandJson(result.stdout, "Supabase 项目创建结果无效")
    const project = parsed.project ?? parsed
    const ref = project.ref ?? project.id
    if (!/^[a-z0-9]{20}$/.test(ref ?? "")) {
      throw new Error("Supabase 项目创建结果无效")
    }
    return { ...project, ref }
  }

  async function waitProjectHealthy(projectRef, options = {}) {
    const attempts = options.attempts ?? 60
    const delay = options.delay ?? ((milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const project = (await listProjects()).find(
        (candidate) => (candidate.ref ?? candidate.id) === projectRef,
      )
      if (project?.status === "ACTIVE_HEALTHY") return project
      if (project?.status?.includes("FAILED")) {
        throw new Error("目标 Supabase 项目创建失败")
      }
      await delay(5_000)
    }
    throw new Error("等待目标 Supabase 项目就绪超时")
  }

  async function getApiKeys(projectRef) {
    const result = await runCommand(
      NPX,
      [
        "supabase",
        "projects",
        "api-keys",
        "--project-ref",
        projectRef,
        "--reveal",
        "--output-format",
        "json",
      ],
      { cwd: workdir, env: commandEnv, operation: "读取目标 Supabase API 密钥" },
    )
    const values = collectStrings(
      parseCommandJson(result.stdout, "Supabase API 密钥结果无效"),
    )
    const publishableKey = values.find((value) => value.startsWith("sb_publishable_"))
    const secretKey = values.find((value) => value.startsWith("sb_secret_"))
    if (!publishableKey || !secretKey) throw new Error("Supabase API 密钥结果无效")
    return { publishableKey, secretKey }
  }

  async function withTemporaryFile(prefix, contents, operation) {
    const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
    const path = join(directory, "input")
    try {
      await writeFile(path, contents, { encoding: "utf8", mode: 0o600 })
      return await operation(path)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async function queryDatabase({
    projectRef,
    region,
    databasePassword,
    sql,
    operation,
  }) {
    return withTemporaryFile("task-roadmap-sql", sql, (path) =>
      runCommand(
        NPX,
        [
          "supabase",
          "db",
          "query",
          "--db-url",
          databaseUrl({ projectRef, region, databasePassword }),
          "--file",
          path,
          "--output-format",
          "json",
        ],
        { cwd: workdir, env: commandEnv, operation },
      ),
    )
  }

  async function applyMigrations({ projectRef, region, databasePassword, dryRun = false }) {
    const args = [
      "supabase",
      "db",
      "push",
      "--db-url",
      databaseUrl({ projectRef, region, databasePassword }),
    ]
    if (dryRun) args.push("--dry-run")
    else args.push("--yes")
    return runCommand(NPX, args, {
      cwd: workdir,
      env: commandEnv,
      operation: dryRun ? "预检目标数据库迁移" : "应用目标数据库迁移",
    })
  }

  async function configureAuth({
    projectRef,
    projectUrl,
    secretKey,
    adminEmail,
    adminPassword,
    createAdmin = true,
  }) {
    const configResponse = await fetchImpl(
      `${SUPABASE_API}/projects/${projectRef}/config/auth`,
      {
        method: "PATCH",
        headers: managementHeaders,
        body: JSON.stringify({
          site_url: `https://${TARGET_DOMAIN}`,
          disable_signup: true,
          external_email_enabled: true,
        }),
      },
    )
    await responseJson(configResponse, "Supabase")

    if (!createAdmin) return { configured: true }

    const adminResponse = await fetchImpl(`${projectUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
        "User-Agent": "task-roadmap-clone/1.0",
      },
      body: JSON.stringify({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
      }),
    })
    return responseJson(adminResponse, "Supabase")
  }

  async function listAuthUsers({ projectUrl, secretKey }) {
    const response = await fetchImpl(
      `${projectUrl}/auth/v1/admin/users?page=1&per_page=1000`,
      {
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          "User-Agent": "task-roadmap-clone/1.0",
        },
      },
    )
    const result = await responseJson(response, "Supabase")
    return Array.isArray(result) ? result : result.users ?? []
  }

  async function setEdgeSecrets({ projectRef, voteIpSalt }) {
    const contents = `VOTE_IP_SALT=${JSON.stringify(voteIpSalt)}\nALLOWED_ORIGINS=${JSON.stringify(`https://${TARGET_DOMAIN},https://${TARGET_PAGES_PROJECT}.pages.dev`)}\n`
    return withTemporaryFile("task-roadmap-secrets", contents, (path) =>
      runCommand(
        NPX,
        ["supabase", "secrets", "set", "--env-file", path, "--project-ref", projectRef],
        { cwd: workdir, env: commandEnv, operation: "设置目标 Edge Function Secrets" },
      ),
    )
  }

  async function deployEdgeFunctions(projectRef) {
    for (const functionName of ["submit-suggestion", "vote"]) {
      await runCommand(
        NPX,
        [
          "supabase",
          "functions",
          "deploy",
          functionName,
          "--project-ref",
          projectRef,
          "--use-api",
          "--import-map",
          "supabase/functions/deno.json",
          "--no-verify-jwt",
        ],
        { cwd: workdir, env: commandEnv, operation: `部署目标函数 ${functionName}` },
      )
    }
  }

  return {
    listProjects,
    createProject,
    waitProjectHealthy,
    getApiKeys,
    queryDatabase,
    applyMigrations,
    configureAuth,
    listAuthUsers,
    setEdgeSecrets,
    deployEdgeFunctions,
  }
}

export function createCloudflareProvider({
  accountId,
  zoneId,
  apiToken,
  runCommand,
  fetchImpl = fetch,
  workdir = process.cwd(),
}) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
    "User-Agent": "task-roadmap-clone/1.0",
  }
  const projectBase = `${CLOUDFLARE_API}/accounts/${accountId}/pages/projects`

  async function request(path, options = {}, allowNotFound = false) {
    return responseJson(
      await fetchImpl(`${CLOUDFLARE_API}${path}`, {
        ...options,
        headers: { ...headers, ...options.headers },
      }),
      "Cloudflare",
      allowNotFound,
    )
  }

  async function ensurePagesProject() {
    const existing = await responseJson(
      await fetchImpl(`${projectBase}/${TARGET_PAGES_PROJECT}`, { headers }),
      "Cloudflare",
      true,
    )
    if (existing) {
      if (existing.name !== TARGET_PAGES_PROJECT) {
        throw new ProviderError("PAGES_PROJECT_CONFLICT", "Cloudflare Pages 项目不匹配")
      }
      return existing
    }
    return responseJson(
      await fetchImpl(projectBase, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: TARGET_PAGES_PROJECT,
          production_branch: "master",
        }),
      }),
      "Cloudflare",
    )
  }

  async function configureRuntime({ supabaseUrl, publishableKey, secretKey }) {
    const envVars = {
      SUPABASE_URL: { type: "plain_text", value: supabaseUrl },
      SUPABASE_PUBLISHABLE_KEY: { type: "plain_text", value: publishableKey },
      SUPABASE_SECRET_KEY: { type: "secret_text", value: secretKey },
    }
    return responseJson(
      await fetchImpl(`${projectBase}/${TARGET_PAGES_PROJECT}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          deployment_configs: {
            production: { env_vars: envVars },
            preview: { env_vars: envVars },
          },
        }),
      }),
      "Cloudflare",
    )
  }

  async function deployPages({ buildEnv, commitHash }) {
    await runCommand(NPX, ["run", "build"], {
      cwd: workdir,
      env: { ...process.env, ...buildEnv },
      operation: "构建 Task Roadmap",
    })
    return runCommand(
      NPX,
      [
        "wrangler",
        "pages",
        "deploy",
        "out",
        `--project-name=${TARGET_PAGES_PROJECT}`,
        "--branch=master",
        `--commit-hash=${commitHash}`,
      ],
      {
        cwd: workdir,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: apiToken,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
        operation: "部署 Task Roadmap Pages",
      },
    )
  }

  async function bindDomain() {
    const query = new URLSearchParams({ "name.exact": TARGET_DOMAIN })
    const records = await request(`/zones/${zoneId}/dns_records?${query}`)
    if (records.length > 0) {
      throw new ProviderError("DOMAIN_CONFLICT", "task.telljax.com 已存在 DNS 记录")
    }

    const projects = await request(`/accounts/${accountId}/pages/projects`)
    const owner = projects.find(
      (project) =>
        project.name !== TARGET_PAGES_PROJECT && project.domains?.includes(TARGET_DOMAIN),
    )
    if (owner) {
      throw new ProviderError("DOMAIN_CONFLICT", "task.telljax.com 已绑定其他 Pages 项目")
    }

    const domains = await request(
      `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains`,
    )
    const existing = domains.find((domain) => domain.name === TARGET_DOMAIN)
    if (existing) return existing
    return request(
      `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains`,
      { method: "POST", body: JSON.stringify({ name: TARGET_DOMAIN }) },
    )
  }

  async function getDomain() {
    return request(
      `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains/${TARGET_DOMAIN}`,
    )
  }

  return {
    ensurePagesProject,
    configureRuntime,
    deployPages,
    bindDomain,
    getDomain,
  }
}
