import { describe, expect, it } from "vitest"

import {
  createCloudflareProvider,
  createSupabaseProvider,
  resolveNpmInvocation,
  resolveNpxInvocation,
} from "../../scripts/task-clone/providers.mjs"

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
  it("independently refuses a mutating database call against the protected source", async () => {
    const provider = createSupabaseProvider({
      accessToken: "management-token",
      protectedProjectRef: "abcdefghijklmnopqrst",
      runCommand: async () => ({ stdout: "{}", stderr: "", exitCode: 0 }),
      fetchImpl: async () => Response.json({}),
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
        sql: "begin transaction isolation level repeatable read read only; select 1; commit;",
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
