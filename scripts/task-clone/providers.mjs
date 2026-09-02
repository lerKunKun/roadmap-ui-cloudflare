import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const SUPABASE_API = "https://api.supabase.com/v1"
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"
const TARGET_DOMAIN = "task.telljax.com"
const TARGET_PAGES_PROJECT = "task-roadmap-ui"

/**
 * @typedef {{
 *   connect: () => Promise<unknown>,
 *   query: (sql: string) => Promise<{
 *     command?: string,
 *     fields?: unknown[],
 *     rows?: unknown[]
 *   } | Array<{
 *     command?: string,
 *     fields?: unknown[],
 *     rows?: unknown[]
 *   }>>,
 *   end: () => Promise<unknown>
 * }} PgClient
 */

const POSTGRES_TIMEOUTS = Object.freeze({
  connectionTimeoutMillis: 15_000,
  statement_timeout: 120_000,
  lock_timeout: 30_000,
  idle_in_transaction_session_timeout: 30_000,
  query_timeout: 125_000,
})

const SAFE_POSTGRES_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "SELF_SIGNED_CERT_IN_CHAIN",
])

export function resolveNpxInvocation(args, runtime = {}) {
  const platform = runtime.platform ?? process.platform
  if (platform !== "win32") return { program: "npx", args: [...args] }
  const execPath = runtime.execPath ?? process.execPath
  const npmExecPath = runtime.npmExecPath ?? process.env.npm_execpath
  const npxCliPath = npmExecPath
    ? join(dirname(npmExecPath), "npx-cli.js")
    : join(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js")
  return { program: execPath, args: [npxCliPath, ...args] }
}

export function resolveNpmInvocation(args, runtime = {}) {
  const platform = runtime.platform ?? process.platform
  if (platform !== "win32") return { program: "npm", args: [...args] }
  const execPath = runtime.execPath ?? process.execPath
  const npmExecPath =
    runtime.npmExecPath ??
    process.env.npm_execpath ??
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
  return { program: execPath, args: [npmExecPath, ...args] }
}

function runNpx(runCommand, args, options) {
  const invocation = resolveNpxInvocation(args)
  return runCommand(invocation.program, invocation.args, options)
}

function runNpm(runCommand, args, options) {
  const invocation = resolveNpmInvocation(args)
  return runCommand(invocation.program, invocation.args, options)
}

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
      `${provider} 请求失败（HTTP ${response.status}${requestId ? `，请求 ${requestId}` : ""}）`
    )
  }
  return provider === "Cloudflare" ? value.result : value
}

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value)
  else if (Array.isArray(value))
    value.forEach((entry) => collectStrings(entry, result))
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

function pgDatabaseUrl({ projectRef, region, databasePassword }) {
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(databasePassword)}@aws-0-${region}.pooler.supabase.com:5432/postgres`
}

/**
 * @param {string} connectionString
 * @param {{
 *   Client?: new (options: Record<string, unknown>) => PgClient,
 *   readFileImpl?: (url: URL, encoding: BufferEncoding) => Promise<string>
 * }} [dependencies]
 * @returns {Promise<PgClient>}
 */
export async function createPgClient(connectionString, dependencies = {}) {
  const Client = dependencies.Client ?? (await import("pg")).Client
  const readFileImpl = dependencies.readFileImpl ?? readFile
  const ca = await readFileImpl(
    new URL("../../supabase/certificates/prod-ca-2021.crt", import.meta.url),
    "utf8"
  )
  return /** @type {PgClient} */ (
    new Client({
      connectionString,
      ssl: { rejectUnauthorized: true, ca },
      application_name: "task-roadmap-clone",
      ...POSTGRES_TIMEOUTS,
    })
  )
}

function assertSingleReadOnlyQuery(sql, errorMessage) {
  const trimmed = sql.trim()
  const statement = trimmed.endsWith(";")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed
  if (
    !/^(select|with)\b/i.test(statement) ||
    statement.includes(";") ||
    /\b(begin|start\s+transaction|commit|rollback|savepoint|release|set\s+transaction|prepare\s+transaction)\b/i.test(
      statement
    ) ||
    /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|call|do)\b/i.test(
      statement
    )
  ) {
    throw new Error(errorMessage)
  }
}

function isRowProducingResult(result) {
  if (!Array.isArray(result?.rows)) return false
  if (Array.isArray(result.fields)) return result.fields.length > 0
  return /^(SELECT|SHOW|TABLE|VALUES|FETCH)$/i.test(result.command ?? "")
}

function safePostgresErrorCode(error, databasePassword) {
  const candidate = typeof error?.code === "string" ? error.code : ""
  if (candidate === databasePassword) return "query"
  if (
    /^[0-9A-Z]{5}$/.test(candidate) ||
    SAFE_POSTGRES_ERROR_CODES.has(candidate)
  ) {
    return candidate
  }
  return "query"
}

export function createSupabaseProvider({
  accessToken,
  protectedProjectRef = /** @type {string | null} */ (null),
  protectedSecretKey = /** @type {string | null} */ (null),
  runCommand,
  fetchImpl = fetch,
  pgClientFactory = createPgClient,
  migrationReadFile = readFile,
  workdir = process.cwd(),
}) {
  const commandEnv = { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken }
  const managementHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "User-Agent": "task-roadmap-clone/1.0",
  }

  function assertMutableProject(projectRef) {
    if (protectedProjectRef && projectRef === protectedProjectRef) {
      throw new Error("拒绝修改源 Supabase 项目")
    }
  }

  function assertProtectedReadOnly(projectRef, sql, readOnly) {
    if (
      protectedProjectRef &&
      projectRef === protectedProjectRef &&
      readOnly !== true
    ) {
      throw new Error("拒绝修改源 Supabase 项目")
    }
    if (readOnly === true) {
      assertSingleReadOnlyQuery(
        sql,
        protectedProjectRef === projectRef
          ? "拒绝修改源 Supabase 项目"
          : "拒绝执行非只读数据库查询"
      )
    }
  }

  async function listProjects() {
    const result = await runNpx(
      runCommand,
      ["supabase", "projects", "list", "--output-format", "json"],
      { cwd: workdir, env: commandEnv, operation: "读取 Supabase 项目列表" }
    )
    const parsed = parseCommandJson(result.stdout, "Supabase 项目列表结果无效")
    const projects = Array.isArray(parsed) ? parsed : parsed.projects
    if (!Array.isArray(projects)) throw new Error("Supabase 项目列表结果无效")
    return projects
  }

  async function createProject({
    name,
    organizationId,
    region,
    databasePassword,
  }) {
    const result = await runNpx(
      runCommand,
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
      { cwd: workdir, env: commandEnv, operation: "创建目标 Supabase 项目" }
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
    const delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const project = (await listProjects()).find(
        (candidate) => (candidate.ref ?? candidate.id) === projectRef
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
    const result = await runNpx(
      runCommand,
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
      { cwd: workdir, env: commandEnv, operation: "读取目标 Supabase API 密钥" }
    )
    const values = collectStrings(
      parseCommandJson(result.stdout, "Supabase API 密钥结果无效")
    )
    const publishableKey = values.find((value) =>
      value.startsWith("sb_publishable_")
    )
    const secretKey = values.find((value) => value.startsWith("sb_secret_"))
    if (!publishableKey || !secretKey)
      throw new Error("Supabase API 密钥结果无效")
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
    readOnly = false,
  }) {
    assertProtectedReadOnly(projectRef, sql, readOnly)
    if (!readOnly) assertMutableProject(projectRef)
    let client
    let operationError = null
    let readOnlyTransactionOpen = false
    try {
      client = await pgClientFactory(
        pgDatabaseUrl({ projectRef, region, databasePassword })
      )
      await client.connect()
      if (readOnly) {
        await client.query(
          "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        )
        readOnlyTransactionOpen = true
      }
      const queryResult = await client.query(sql)
      if (readOnly) {
        await client.query("COMMIT")
        readOnlyTransactionOpen = false
      }
      const results = Array.isArray(queryResult) ? queryResult : [queryResult]
      const rowResult = [...results].reverse().find(isRowProducingResult)
      return {
        stdout: JSON.stringify({ rows: rowResult?.rows ?? [] }),
        stderr: "",
        exitCode: 0,
      }
    } catch (error) {
      operationError = error
      if (client && readOnlyTransactionOpen) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // The original database error is more useful and must not be masked.
        }
      }
      const code = safePostgresErrorCode(error, databasePassword)
      throw new Error(`${operation}失败（PostgreSQL ${code}）`)
    } finally {
      if (client) {
        try {
          await client.end()
        } catch {
          if (!operationError)
            throw new Error(`${operation}失败（关闭 PostgreSQL 连接）`)
        }
      }
    }
  }

  async function applyProtectedSourceMigration({
    projectRef,
    region,
    databasePassword,
    migrationPath,
    expectedSha256,
  }) {
    if (!protectedProjectRef || projectRef !== protectedProjectRef) {
      throw new Error("源迁移目标不是受保护源项目")
    }
    const approvedPath = resolve(
      workdir,
      "supabase/migrations/20260902090000_advertising_sync_export.sql"
    )
    if (resolve(migrationPath) !== approvedPath) {
      throw new Error("源迁移文件不在允许范围内")
    }

    const migration = await migrationReadFile(approvedPath, "utf8")
    const sha256 = createHash("sha256").update(migration).digest("hex")
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") ||
      sha256 !== expectedSha256
    ) {
      throw new Error("源迁移校验和不匹配")
    }
    const forbidden =
      /\b(insert|update|delete|truncate|drop|alter|call|do)\b|\b(create\s+(table|schema|extension|trigger|policy|view))\b|\b(auth|vault|cron|storage)\s*\./i
    const required = [
      /create\s+or\s+replace\s+function\s+public\.export_advertising_roadmap_snapshot\s*\(\s*\)/i,
      /where\s+slug\s*=\s*'advertising-system'/i,
      /security\s+definer/i,
      /set\s+search_path\s*=\s*''/i,
      /grant\s+execute\s+on\s+function\s+public\.export_advertising_roadmap_snapshot\s*\(\s*\)\s+to\s+service_role/i,
    ]
    if (
      forbidden.test(migration) ||
      required.some((pattern) => !pattern.test(migration))
    ) {
      throw new Error("源迁移内容不在允许范围内")
    }

    let client
    let transactionOpen = false
    let operationError = null
    try {
      client = await pgClientFactory(
        pgDatabaseUrl({ projectRef, region, databasePassword })
      )
      await client.connect()
      await client.query("BEGIN")
      transactionOpen = true
      await client.query(migration)
      await client.query("COMMIT")
      transactionOpen = false
      return { applied: true, sha256 }
    } catch (error) {
      operationError = error
      if (client && transactionOpen) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // Preserve the approved migration error.
        }
      }
      throw new Error("应用源只读导出迁移失败")
    } finally {
      if (client) {
        try {
          await client.end()
        } catch {
          if (!operationError) throw new Error("关闭源数据库连接失败")
        }
      }
    }
  }

  async function applyMigrations({
    projectRef,
    region,
    databasePassword,
    dryRun = false,
  }) {
    assertMutableProject(projectRef)
    const args = [
      "supabase",
      "db",
      "push",
      "--db-url",
      databaseUrl({ projectRef, region, databasePassword }),
    ]
    if (dryRun) args.push("--dry-run")
    else args.push("--yes")
    return runNpx(runCommand, args, {
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
  }) {
    assertMutableProject(projectRef)
    const expectedProjectUrl = `https://${projectRef}.supabase.co`
    if (projectUrl !== expectedProjectUrl) {
      throw new Error("Auth URL 与目标项目不匹配")
    }
    if (protectedSecretKey && secretKey === protectedSecretKey) {
      throw new Error("拒绝使用源 Supabase Secret 修改目标 Auth")
    }
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
      }
    )
    await responseJson(configResponse, "Supabase")

    const verifiedConfig = await getAuthConfig(projectRef)
    if (
      verifiedConfig?.disable_signup !== true ||
      verifiedConfig?.site_url !== `https://${TARGET_DOMAIN}`
    ) {
      throw new Error("目标 Auth 配置回读不一致")
    }

    const users = await listAuthUsers({ projectUrl, secretKey })
    if (
      users.length > 1 ||
      (users.length === 1 && users[0].email !== adminEmail)
    ) {
      throw new Error("目标 Auth 已存在非预期用户")
    }
    const existing = users[0]
    const adminUrl = existing
      ? `${projectUrl}/auth/v1/admin/users/${encodeURIComponent(existing.id)}`
      : `${projectUrl}/auth/v1/admin/users`
    const adminResponse = await fetchImpl(adminUrl, {
      method: existing ? "PUT" : "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
        "User-Agent": "task-roadmap-clone/1.0",
      },
      body: JSON.stringify(
        existing
          ? { password: adminPassword, email_confirm: true }
          : {
              email: adminEmail,
              password: adminPassword,
              email_confirm: true,
            }
      ),
    })
    await responseJson(adminResponse, "Supabase")

    const loginResponse = await fetchImpl(
      `${projectUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          "content-type": "application/json",
          "User-Agent": "task-roadmap-clone/1.0",
        },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      }
    )
    const login = await responseJson(loginResponse, "Supabase")
    if (!login?.access_token) throw new Error("目标管理员密码验证失败")
    return { configured: true, adminId: existing?.id ?? null }
  }

  async function getAuthConfig(projectRef) {
    return responseJson(
      await fetchImpl(`${SUPABASE_API}/projects/${projectRef}/config/auth`, {
        headers: managementHeaders,
      }),
      "Supabase"
    )
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
      }
    )
    const result = await responseJson(response, "Supabase")
    return Array.isArray(result) ? result : (result.users ?? [])
  }

  async function setEdgeSecrets({ projectRef, voteIpSalt }) {
    assertMutableProject(projectRef)
    const contents = `VOTE_IP_SALT=${JSON.stringify(voteIpSalt)}\nALLOWED_ORIGINS=${JSON.stringify(`https://${TARGET_DOMAIN},https://${TARGET_PAGES_PROJECT}.pages.dev`)}\n`
    return withTemporaryFile("task-roadmap-secrets", contents, (path) =>
      runNpx(
        runCommand,
        [
          "supabase",
          "secrets",
          "set",
          "--env-file",
          path,
          "--project-ref",
          projectRef,
        ],
        {
          cwd: workdir,
          env: commandEnv,
          operation: "设置目标 Edge Function Secrets",
        }
      )
    )
  }

  async function setAdvertisingSyncEdgeSecrets({
    targetProjectRef,
    cronSecret,
    sourceUrl,
    sourceSecretKey,
    sourceProjectRef,
  }) {
    assertMutableProject(targetProjectRef)
    if (
      !/^[a-z0-9]{20}$/.test(sourceProjectRef ?? "") ||
      sourceProjectRef !== protectedProjectRef ||
      targetProjectRef === sourceProjectRef ||
      sourceUrl !== `https://${sourceProjectRef}.supabase.co` ||
      !/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(sourceSecretKey ?? "") ||
      !/^[a-f0-9]{64}$/.test(cronSecret ?? "")
    ) {
      throw new Error("广告同步 Edge Secrets 配置无效")
    }
    const contents = [
      ["ADVERTISING_SYNC_CRON_SECRET", cronSecret],
      ["SOURCE_SUPABASE_URL", sourceUrl],
      ["SOURCE_SUPABASE_SECRET_KEY", sourceSecretKey],
      ["SOURCE_SUPABASE_PROJECT_REF", sourceProjectRef],
      ["TARGET_SUPABASE_PROJECT_REF", targetProjectRef],
    ]
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n")
    return withTemporaryFile(
      "task-roadmap-advertising-sync-secrets",
      `${contents}\n`,
      (path) =>
        runNpx(
          runCommand,
          [
            "supabase",
            "secrets",
            "set",
            "--env-file",
            path,
            "--project-ref",
            targetProjectRef,
          ],
          {
            cwd: workdir,
            env: commandEnv,
            operation: "设置广告同步 Edge Function Secrets",
          }
        )
    )
  }

  async function deployEdgeFunction(projectRef, functionName) {
    assertMutableProject(projectRef)
    if (
      !new Set(["submit-suggestion", "vote", "sync-advertising"]).has(
        functionName
      )
    ) {
      throw new Error("Edge Function 不在允许列表")
    }
    return runNpx(
      runCommand,
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
      {
        cwd: workdir,
        env: commandEnv,
        operation: `部署目标函数 ${functionName}`,
      }
    )
  }

  async function deployEdgeFunctions(projectRef) {
    for (const functionName of ["submit-suggestion", "vote"]) {
      await deployEdgeFunction(projectRef, functionName)
    }
  }

  return {
    listProjects,
    createProject,
    waitProjectHealthy,
    getApiKeys,
    queryDatabase,
    applyProtectedSourceMigration,
    applyMigrations,
    configureAuth,
    getAuthConfig,
    listAuthUsers,
    setEdgeSecrets,
    setAdvertisingSyncEdgeSecrets,
    deployEdgeFunction,
    deployEdgeFunctions,
  }
}

export function createCloudflareProvider({
  accountId,
  zoneId,
  apiToken,
  protectedPagesProject = /** @type {string | null} */ (null),
  protectedSupabaseProjectRef = /** @type {string | null} */ (null),
  protectedSupabasePublishableKey = /** @type {string | null} */ (null),
  protectedSupabaseSecretKey = /** @type {string | null} */ (null),
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
  let configuredTargetRef = null

  function assertMutableTarget() {
    if (protectedPagesProject === TARGET_PAGES_PROJECT) {
      throw new Error("拒绝修改源 Cloudflare Pages 项目")
    }
  }

  async function request(path, options = {}, allowNotFound = false) {
    return responseJson(
      await fetchImpl(`${CLOUDFLARE_API}${path}`, {
        ...options,
        headers: { ...headers, ...options.headers },
      }),
      "Cloudflare",
      allowNotFound
    )
  }

  async function ensurePagesProject() {
    assertMutableTarget()
    const existing = await responseJson(
      await fetchImpl(`${projectBase}/${TARGET_PAGES_PROJECT}`, { headers }),
      "Cloudflare",
      true
    )
    if (existing) {
      if (existing.name !== TARGET_PAGES_PROJECT) {
        throw new ProviderError(
          "PAGES_PROJECT_CONFLICT",
          "Cloudflare Pages 项目不匹配"
        )
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
      "Cloudflare"
    )
  }

  async function configureRuntime({ supabaseUrl, publishableKey, secretKey }) {
    assertMutableTarget()
    const targetUrl = new URL(supabaseUrl)
    const targetMatch = /^([a-z0-9]{20})\.supabase\.co$/.exec(
      targetUrl.hostname
    )
    if (
      targetUrl.protocol !== "https:" ||
      targetUrl.pathname !== "/" ||
      !targetMatch
    ) {
      throw new Error("目标 Pages Supabase URL 无效")
    }
    if (
      protectedSupabaseProjectRef &&
      new URL(supabaseUrl).hostname ===
        `${protectedSupabaseProjectRef}.supabase.co`
    ) {
      throw new Error("拒绝将源 Supabase 绑定到目标 Pages")
    }
    if (
      (protectedSupabasePublishableKey &&
        publishableKey === protectedSupabasePublishableKey) ||
      (protectedSupabaseSecretKey && secretKey === protectedSupabaseSecretKey)
    ) {
      throw new Error("拒绝将源 Supabase 凭据绑定到目标 Pages")
    }
    configuredTargetRef = targetMatch[1]
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
      "Cloudflare"
    )
  }

  async function deployPages({ buildEnv, commitHash }) {
    assertMutableTarget()
    if (
      protectedSupabaseProjectRef &&
      buildEnv?.NEXT_PUBLIC_SUPABASE_URL ===
        `https://${protectedSupabaseProjectRef}.supabase.co`
    ) {
      throw new Error("拒绝使用源 Supabase 构建目标 Pages")
    }
    if (
      protectedSupabasePublishableKey &&
      buildEnv?.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ===
        protectedSupabasePublishableKey
    ) {
      throw new Error("拒绝使用源 Supabase 凭据构建目标 Pages")
    }
    if (
      !configuredTargetRef ||
      buildEnv?.NEXT_PUBLIC_SUPABASE_URL !==
        `https://${configuredTargetRef}.supabase.co`
    ) {
      throw new Error("目标 Pages 构建配置与运行时 Supabase 不匹配")
    }
    await runNpm(runCommand, ["run", "build"], {
      cwd: workdir,
      env: { ...process.env, ...buildEnv },
      operation: "构建 Task Roadmap",
    })
    return runNpx(
      runCommand,
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
      }
    )
  }

  async function bindDomain() {
    assertMutableTarget()
    const query = new URLSearchParams({ "name.exact": TARGET_DOMAIN })
    const records = await request(`/zones/${zoneId}/dns_records?${query}`)
    const expectedTarget = `${TARGET_PAGES_PROJECT}.pages.dev`
    const recordsMatchTarget = records.every(
      (record) =>
        record.name === TARGET_DOMAIN &&
        record.type === "CNAME" &&
        record.content?.replace(/\.$/, "") === expectedTarget &&
        record.proxied === true
    )
    if (records.length > 0 && !recordsMatchTarget) {
      throw new ProviderError(
        "DOMAIN_CONFLICT",
        "task.telljax.com 已存在 DNS 记录"
      )
    }

    const projects = await request(`/accounts/${accountId}/pages/projects`)
    const owner = projects.find(
      (project) =>
        project.name !== TARGET_PAGES_PROJECT &&
        project.domains?.includes(TARGET_DOMAIN)
    )
    if (owner) {
      throw new ProviderError(
        "DOMAIN_CONFLICT",
        "task.telljax.com 已绑定其他 Pages 项目"
      )
    }

    const domains = await request(
      `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains`
    )
    const existing = domains.find((domain) => domain.name === TARGET_DOMAIN)
    const domain =
      existing ??
      (await request(
        `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains`,
        { method: "POST", body: JSON.stringify({ name: TARGET_DOMAIN }) }
      ))
    if (records.length === 0) {
      await request(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: TARGET_DOMAIN,
          content: expectedTarget,
          proxied: true,
          ttl: 1,
        }),
      })
    }
    return domain
  }

  async function getDomain() {
    return request(
      `/accounts/${accountId}/pages/projects/${TARGET_PAGES_PROJECT}/domains/${TARGET_DOMAIN}`
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
