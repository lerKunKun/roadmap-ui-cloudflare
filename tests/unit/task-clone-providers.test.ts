import { describe, expect, it } from "vitest"

import {
  createCloudflareProvider,
  createSupabaseProvider,
} from "../../scripts/task-clone/providers.mjs"

describe("task clone Supabase provider", () => {
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

  it("disables signup and creates one confirmed target administrator", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ url: request.url, method: request.method, body })
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
        url: "https://abcdefghijklmnopqrst.supabase.co/auth/v1/admin/users",
        method: "POST",
        body: {
          email: "roadmap-admin@internal.invalid",
          password: "Strong-admin-password-2026!LongValue",
          email_confirm: true,
        },
      },
    ])
  })
})
describe("task clone Cloudflare provider", () => {
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
})
