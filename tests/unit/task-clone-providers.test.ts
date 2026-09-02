import { X509Certificate } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  createCloudflareProvider,
  createPgClient,
  createSupabaseProvider,
  resolveNpmInvocation,
  resolveNpxInvocation,
} from "../../scripts/task-clone/providers.mjs"

it("pins the official Supabase database root CA", async () => {
  const certificate = new X509Certificate(
    await readFile(
      resolve(process.cwd(), "supabase/certificates/prod-ca-2021.crt"),
      "utf8",
    ),
  )

  expect(certificate.ca).toBe(true)
  expect(certificate.subject).toContain("CN=Supabase Root 2021 CA")
  expect(certificate.fingerprint256).toBe(
    "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
  )
})

it("runs npx through Node instead of spawning a Windows command shim", () => {
  expect(
    resolveNpxInvocation(["supabase", "--version"], {
      platform: "win32",
      execPath: "C:\\nvm4w\\nodejs\\node.exe",
      npmExecPath: "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    }),
  ).toEqual({
    program: "C:\\nvm4w\\nodejs\\node.exe",
    args: [
      "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
      "supabase",
      "--version",
    ],
  })
})

it("runs npm scripts through the npm CLI on Windows", () => {
  expect(
    resolveNpmInvocation(["run", "build"], {
      platform: "win32",
      execPath: "C:\\nvm4w\\nodejs\\node.exe",
      npmExecPath: "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    }),
  ).toEqual({
    program: "C:\\nvm4w\\nodejs\\node.exe",
    args: [
      "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "run",
      "build",
    ],
  })
})

describe("task clone Supabase provider", () => {
  it("configures bounded PostgreSQL connection, statement, lock, and idle timeouts", async () => {
    let config: Record<string, unknown> | undefined
    class FakeClient {
      constructor(options: Record<string, unknown>) {
        config = options
      }

      async connect() {}

      async query() {
        return { rows: [] }
      }

      async end() {}
    }

    await createPgClient("postgresql://example.invalid/postgres", {
      Client: FakeClient,
      readFileImpl: async () => "test-ca",
    })

    expect(config).toMatchObject({
      connectionTimeoutMillis: 15_000,
      statement_timeout: 120_000,
      lock_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
      query_timeout: 125_000,
    })
  })

  it("keeps the protected source inside a provider-owned read-only transaction", async () => {
    const events: string[] = []
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => events.push("connect"),
        query: async (sql: string) => {
          events.push(sql)
          return { command: "SELECT", fields: [{ name: "one" }], rows: [{ one: 1 }] }
        },
        end: async () => events.push("end"),
      }),
    })

    await expect(
      provider.queryDatabase({
        projectRef: "abcdefghijklmnopqrst",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "select 1 as one",
        operation: "safe",
        readOnly: true,
      }),
    ).resolves.toEqual({
      stdout: JSON.stringify({ rows: [{ one: 1 }] }),
      stderr: "",
      exitCode: 0,
    })
    expect(events).toEqual([
      "connect",
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "select 1 as one",
      "COMMIT",
      "end",
    ])
  })

  it("rejects a protected-source transaction escape before connecting", async () => {
    let connected = false
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => {
          connected = true
        },
        query: async () => ({ rows: [] }),
        end: async () => {},
      }),
    })

    await expect(
      provider.queryDatabase({
        projectRef: "abcdefghijklmnopqrst",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "select 1; commit; select public.consume_suggestion_image_quota('x')",
        operation: "unsafe escape",
        readOnly: true,
      }),
    ).rejects.toThrow("拒绝修改源 Supabase 项目")
    expect(connected).toBe(false)
  })

  it("rolls back and closes after a read-only query fails without leaking credentials", async () => {
    const events: string[] = []
    const databasePassword = "hiddenpassword123"
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => events.push("connect"),
        query: async (sql: string) => {
          events.push(sql)
          if (sql === "select 1") {
            const error = new Error(`failed ${databasePassword}`)
            Object.assign(error, { code: databasePassword })
            throw error
          }
          return { rows: [] }
        },
        end: async () => events.push("end"),
      }),
    })

    const promise = provider.queryDatabase({
      projectRef: "abcdefghijklmnopqrst",
      region: "us-west-2",
      databasePassword,
      sql: "select 1",
      operation: "snapshot",
      readOnly: true,
    })
    await expect(promise).rejects.toThrow("snapshot失败（PostgreSQL query）")
    await expect(promise).rejects.not.toThrow(databasePassword)
    expect(events).toEqual([
      "connect",
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "select 1",
      "ROLLBACK",
      "end",
    ])
  })

  it("closes the PostgreSQL client when connecting fails", async () => {
    const events: string[] = []
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => {
          events.push("connect")
          throw Object.assign(new Error("connection failed"), {
            code: "ECONNREFUSED",
          })
        },
        query: async () => ({ rows: [] }),
        end: async () => events.push("end"),
      }),
    })

    await expect(
      provider.queryDatabase({
        projectRef: "bcdefghijklmnopqrstu",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "select 1",
        operation: "connect",
      }),
    ).rejects.toThrow("connect失败（PostgreSQL ECONNREFUSED）")
    expect(events).toEqual(["connect", "end"])
  })

  it("returns the final row-producing result even when it has no rows", async () => {
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => {},
        query: async () => [
          { command: "SELECT", fields: [{ name: "old" }], rows: [{ old: true }] },
          { command: "SELECT", fields: [{ name: "current" }], rows: [] },
          { command: "COMMIT", fields: [], rows: [] },
        ],
        end: async () => {},
      }),
    })

    await expect(
      provider.queryDatabase({
        projectRef: "bcdefghijklmnopqrstu",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "select true as old; select false as current; commit;",
        operation: "empty result",
      }),
    ).resolves.toMatchObject({ stdout: JSON.stringify({ rows: [] }) })
  })

  it("executes multi-statement SQL on one PostgreSQL connection", async () => {
    const events: string[] = []
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => {
        throw new Error("Supabase CLI db query must not be used")
      },
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async (connectionString: string) => {
        expect(connectionString).toContain("postgres.bcdefghijklmnopqrstu")
        expect(connectionString).not.toContain("hidden password")
        return {
          connect: async () => events.push("connect"),
          query: async (sql: string) => {
            events.push(sql)
            return [
              { command: "BEGIN", fields: [], rows: [] },
              {
                command: "SELECT",
                fields: [{ name: "snapshot" }],
                rows: [{ snapshot: { version: 1 } }],
              },
              { command: "COMMIT", fields: [], rows: [] },
            ]
          },
          end: async () => events.push("end"),
        }
      },
    })

    await expect(
      provider.queryDatabase({
        projectRef: "bcdefghijklmnopqrstu",
        region: "us-west-2",
        databasePassword: "hidden password",
        sql: "begin; select jsonb_build_object('version', 1) as snapshot; commit;",
        operation: "multi statement",
      }),
    ).resolves.toEqual({
      stdout: JSON.stringify({ rows: [{ snapshot: { version: 1 } }] }),
      stderr: "",
      exitCode: 0,
    })
    expect(events).toEqual([
      "connect",
      "begin; select jsonb_build_object('version', 1) as snapshot; commit;",
      "end",
    ])
  })

  it("independently refuses a mutating database call against the protected source", async () => {
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
      pgClientFactory: async () => ({
        connect: async () => {},
        query: async () => ({ rows: [{ one: 1 }] }),
        end: async () => {},
      }),
    })

    await expect(
      provider.queryDatabase({
        projectRef: "abcdefghijklmnopqrst",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "delete from public.projects",
        operation: "unsafe",
      }),
    ).rejects.toThrow("拒绝修改源 Supabase 项目")

    await expect(
      provider.queryDatabase({
        projectRef: "abcdefghijklmnopqrst",
        region: "us-west-2",
        databasePassword: "hidden",
        sql: "select 1",
        operation: "safe",
        readOnly: true,
      }),
    ).resolves.toBeDefined()
  })

  it("selects the new publishable and secret keys without returning wrappers", async () => {
    const runCommand = async () => ({
      stdout: JSON.stringify({
        apiKeys: [
          { name: "publishable", api_key: `sb_publishable_${"a".repeat(32)}` },
          { name: "secret", api_key: `sb_secret_${"b".repeat(32)}` },
        ],
      }),
      stderr: "",
      exitCode: 0,
    })
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      runCommand,
      fetchImpl: async () => new Response(),
    })

    await expect(
      provider.getApiKeys("abcdefghijklmnopqrst"),
    ).resolves.toEqual({
      publishableKey: `sb_publishable_${"a".repeat(32)}`,
      secretKey: `sb_secret_${"b".repeat(32)}`,
    })
  })

  it("disables signup, resets one administrator password, and verifies login", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ url: request.url, method: request.method, body })
      if (request.method === "GET" && request.url.includes("config/auth")) {
        return Response.json({
          site_url: "https://task.telljax.com",
          disable_signup: true,
          external_email_enabled: true,
        })
      }
      if (request.method === "GET" && request.url.includes("admin/users")) {
        return Response.json({
          users: [
            {
              id: "admin-user",
              email: "roadmap-admin@internal.invalid",
            },
          ],
        })
      }
      if (request.url.includes("grant_type=password")) {
        return Response.json({ access_token: "verified" })
      }
      return Response.json({ id: "admin-user" })
    }
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl,
    })

    await provider.configureAuth({
      projectRef: "abcdefghijklmnopqrst",
      projectUrl: "https://abcdefghijklmnopqrst.supabase.co",
      secretKey: `sb_secret_${"b".repeat(32)}`,
      adminEmail: "roadmap-admin@internal.invalid",
      adminPassword: "Strong-admin-password-2026!LongValue",
    })

    expect(requests).toEqual([
      {
        url: "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth",
        method: "PATCH",
        body: {
          site_url: "https://task.telljax.com",
          disable_signup: true,
          external_email_enabled: true,
        },
      },
      {
        url: "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/config/auth",
        method: "GET",
        body: null,
      },
      {
        url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/admin/users?page=1&per_page=1000",
        method: "GET",
        body: null,
      },
      {
        url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/admin/users/admin-user",
        method: "PUT",
        body: {
          password: "Strong-admin-password-2026!LongValue",
          email_confirm: true,
        },
      },
      {
        url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/token?grant_type=password",
        method: "POST",
        body: {
          email: "roadmap-admin@internal.invalid",
          password: "Strong-admin-password-2026!LongValue",
        },
      },
    ])
  })

  it("fails when closed signup cannot be verified by readback", async () => {
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.method === "GET") return Response.json({ disable_signup: false })
        return Response.json({})
      },
    })

    await expect(
      provider.configureAuth({
        projectRef: "bcdefghijklmnopqrstu",
        projectUrl: "https://bcdefghijklmnopqrstu.supabase.co",
        secretKey: `sb_secret_${"b".repeat(32)}`,
        adminEmail: "roadmap-admin@internal.invalid",
        adminPassword: "Strong-admin-password-2026!LongValue",
      }),
    ).rejects.toThrow("Auth 配置回读不一致")
  })

  it("refuses an Auth URL that does not match the guarded target ref", async () => {
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
    })

    await expect(
      provider.configureAuth({
        projectRef: "bcdefghijklmnopqrstu",
        projectUrl: "https://abcdefghijklmnopqrst.supabase.co",
        secretKey: `sb_secret_${"b".repeat(32)}`,
        adminEmail: "roadmap-admin@internal.invalid",
        adminPassword: "Strong-admin-password-2026!LongValue",
      }),
    ).rejects.toThrow("Auth URL 与目标项目不匹配")
  })
})
describe("task clone Cloudflare provider", () => {
  it("refuses to mutate when the protected Pages project is the target", async () => {
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      protectedPagesProject: "task-roadmap-ui",
      fetchImpl: async () => Response.json({ success: true, result: {} }),
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(provider.ensurePagesProject()).rejects.toThrow(
      "拒绝修改源 Cloudflare Pages 项目",
    )
  })

  it("refuses to bind the protected source Supabase to target Pages", async () => {
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      protectedPagesProject: "roadmap-ui",
      protectedSupabaseProjectRef: "abcdefghijklmnopqrst",
      fetchImpl: async () => Response.json({ success: true, result: {} }),
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(
      provider.configureRuntime({
        supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
        publishableKey: `sb_publishable_${"c".repeat(32)}`,
        secretKey: `sb_secret_${"d".repeat(32)}`,
      }),
    ).rejects.toThrow("拒绝将源 Supabase 绑定到目标 Pages")
  })

  it("refuses to build target Pages with a protected source Supabase URL", async () => {
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      protectedPagesProject: "roadmap-ui",
      protectedSupabaseProjectRef: "abcdefghijklmnopqrst",
      fetchImpl: async () => Response.json({ success: true, result: {} }),
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(
      provider.deployPages({
        buildEnv: {
          NEXT_PUBLIC_SUPABASE_URL:
            "https://abcdefghijklmnopqrst.supabase.co",
        },
        commitHash: "f".repeat(40),
      }),
    ).rejects.toThrow("拒绝使用源 Supabase 构建目标 Pages")
  })

  it("creates the Pages project and configures target bindings in both environments", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    let projectExists = false
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ url: request.url, method: request.method, body })
      if (request.method === "GET" && !projectExists) {
        return Response.json({ success: false, errors: [] }, { status: 404 })
      }
      if (request.method === "POST") projectExists = true
      return Response.json({ success: true, result: { name: "task-roadmap-ui" } })
    }
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      fetchImpl,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await provider.ensurePagesProject()
    await provider.configureRuntime({
      supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      publishableKey: `sb_publishable_${"c".repeat(32)}`,
      secretKey: `sb_secret_${"d".repeat(32)}`,
    })

    expect(requests[1]).toMatchObject({
      method: "POST",
      body: { name: "task-roadmap-ui", production_branch: "master" },
    })
    expect(requests[2]).toMatchObject({
      method: "PATCH",
      body: {
        deployment_configs: {
          production: {
            env_vars: {
              SUPABASE_URL: {
                type: "plain_text",
                value: "https://abcdefghijklmnopqrst.supabase.co",
              },
              SUPABASE_PUBLISHABLE_KEY: {
                type: "plain_text",
                value: `sb_publishable_${"c".repeat(32)}`,
              },
              SUPABASE_SECRET_KEY: {
                type: "secret_text",
                value: `sb_secret_${"d".repeat(32)}`,
              },
            },
          },
          preview: {
            env_vars: expect.any(Object),
          },
        },
      },
    })
  })

  it("stops before domain mutation when an exact DNS record exists", async () => {
    const methods: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      methods.push(request.method)
      if (request.url.includes("/dns_records")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "record-id",
              name: "task.telljax.com",
              type: "A",
              content: "192.0.2.10",
            },
          ],
        })
      }
      return Response.json({ success: true, result: [] })
    }
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      fetchImpl,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(provider.bindDomain()).rejects.toMatchObject({
      code: "DOMAIN_CONFLICT",
    })
    expect(methods).toEqual(["GET"])
  })

  it("creates the exact proxied CNAME when the domain has no DNS record", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push({
        url: request.url,
        method: request.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      if (request.url.includes("/dns_records") && request.method === "GET") {
        return Response.json({ success: true, result: [] })
      }
      if (request.url.endsWith("/pages/projects")) {
        return Response.json({ success: true, result: [] })
      }
      if (request.url.endsWith("/domains") && request.method === "GET") {
        return Response.json({
          success: true,
          result: [{ name: "task.telljax.com", status: "pending" }],
        })
      }
      if (request.url.includes("/dns_records") && request.method === "POST") {
        return Response.json({
          success: true,
          result: {
            name: "task.telljax.com",
            type: "CNAME",
            content: "task-roadmap-ui.pages.dev",
            proxied: true,
          },
        })
      }
      return Response.json({ success: true, result: [] })
    }
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      fetchImpl,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(provider.bindDomain()).resolves.toMatchObject({
      name: "task.telljax.com",
      status: "pending",
    })
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      body: {
        type: "CNAME",
        name: "task.telljax.com",
        content: "task-roadmap-ui.pages.dev",
        proxied: true,
        ttl: 1,
      },
    })
  })

  it("accepts an existing target CNAME and active target Pages binding", async () => {
    const methods: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      methods.push(request.method)
      if (request.url.includes("/dns_records")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "record-id",
              name: "task.telljax.com",
              type: "CNAME",
              content: "task-roadmap-ui.pages.dev",
              proxied: true,
            },
          ],
        })
      }
      if (request.url.endsWith("/pages/projects")) {
        return Response.json({
          success: true,
          result: [
            { name: "task-roadmap-ui", domains: ["task.telljax.com"] },
          ],
        })
      }
      return Response.json({
        success: true,
        result: [{ name: "task.telljax.com", status: "active" }],
      })
    }
    const provider = createCloudflareProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "cloudflare-token",
      fetchImpl,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    })

    await expect(provider.bindDomain()).resolves.toMatchObject({
      name: "task.telljax.com",
      status: "active",
    })
    expect(methods).toEqual(["GET", "GET", "GET"])
  })
})
