import { describe, expect, it, vi } from "vitest"
import {
  consumeSession,
  forwardFeedback,
  ssoCallback,
  ssoStart,
} from "../../functions/_workbench"

const itemId = "d3eb0036-7746-46ce-a208-2af65d3c7ed4"
const userId = "4c4ef239-6945-4e21-aa41-c426406d85de"
const url = "https://admin.telljax.com/workbench/api"
const env = {
  WORKBENCH_SSO_KEY: "s".repeat(40),
  WORKBENCH_FEEDBACK_KEY: "f".repeat(40),
  WORKBENCH_DISPATCH_KEY: "d".repeat(40),
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "public",
  SUPABASE_SECRET_KEY: "private",
  WORKBENCH_SUPABASE_ADMIN_ID: userId,
  WORKBENCH_SUPABASE_ADMIN_EMAIL: "roadmap-admin@internal.invalid",
}
const payload = () =>
  new Request(url + "/feedback", {
    method: "POST",
    headers: {
      authorization: "Bearer session",
      origin: "https://admin.telljax.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ itemId, summary: "Reviewed excerpt" }),
  })

describe("Roadmap workbench integration", () => {
  it("keeps the Workers fetch receiver for a real runtime call", async () => {
    const upstream = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation")
      return Promise.resolve(Response.json({ ok: true }))
    })
    vi.stubGlobal("fetch", upstream)
    try {
      const request = new Request(url + "/sso/session", {
        method: "POST",
        headers: {
          origin: "https://admin.telljax.com",
          cookie: "__Host-wb-roadmap-otp=" + "1".repeat(56),
        },
      })
      await consumeSession(request, env)
      expect(upstream.mock.contexts[0]).toBe(globalThis)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("does not let a non-admin read or forward an item", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: itemId }))
    expect((await forwardFeedback(payload(), env, upstream)).status).toBe(403)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it("uses the current public row and sends only the approved fields to n8n ingress", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: userId, email: env.WORKBENCH_SUPABASE_ADMIN_EMAIL })
      )
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: itemId,
            project_id: userId,
            title: "Request A",
            status: "approved",
            vote_count: "12",
            storage_path: "private",
          },
        ])
      )
      .mockResolvedValueOnce(
        Response.json({ id: itemId, state: "triage", project: "internal" })
      )
    const req = new Request(payload(), {
      body: JSON.stringify({ itemId, summary: "Reviewed excerpt" }),
    })
    const resp = await forwardFeedback(
      req,
      { ...env, WORKBENCH_FEEDBACK_MODE: "n8n" },
      upstream
    )
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ ok: true })
    const [destination, init] = upstream.mock.calls[3]
    expect(destination).toBe(
      "https://kb.biounetwork.com/api/integrations/roadmap/dispatch"
    )
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${env.WORKBENCH_DISPATCH_KEY}`
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      itemId,
      projectId: userId,
      title: "Request A",
      summary: "Reviewed excerpt",
      votes: 12,
    })
  })

  it("never exchanges a grant if the browser state does not match", async () => {
    const upstream = vi.fn<typeof fetch>()
    const start = await ssoStart(new Request(url + "/sso/start"), env)
    const cookie = start.headers.get("set-cookie")!.split(";")[0]
    const resp = await ssoCallback(
      new Request(
        url +
          "/sso/callback?state=" +
          "b".repeat(43) +
          "&grant=" +
          "g".repeat(43),
        { headers: { cookie } }
      ),
      env,
      upstream
    )
    expect(resp.headers.get("location")).toBe("/admin/?workbench=error")
    expect(upstream).not.toHaveBeenCalled()
  })

  it("uses the bound Supabase account after successful workbench exchange", async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({
          id: userId,
          email: env.WORKBENCH_SUPABASE_ADMIN_EMAIL,
          hashed_token: "1".repeat(56),
        })
      )
    const start = await ssoStart(new Request(url + "/sso/start"), env)
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )
    const cookie = start.headers.get("set-cookie")!.split(";")[0]
    expect(start.headers.get("set-cookie")).toContain("HttpOnly")
    const resp = await ssoCallback(
      new Request(
        url + "/sso/callback?state=" + state + "&grant=" + "g".repeat(43),
        { headers: { cookie } }
      ),
      env,
      upstream
    )
    expect(resp.headers.get("location")).toBe("/admin/?workbench=finish")
    expect(resp.headers.getSetCookie().join(" ")).toContain("HttpOnly")
    expect(resp.headers.get("cache-control")).toBe("no-store")
    expect(upstream.mock.calls[1][0]).toBe(
      "https://demo.supabase.co/auth/v1/admin/generate_link"
    )
  })

  it("won't reveal a session to a cross-origin request", async () => {
    const upstream = vi.fn<typeof fetch>()
    const resp = await consumeSession(
      new Request(url + "/sso/session", {
        method: "POST",
        headers: { origin: "https://other.example" },
      }),
      env,
      upstream
    )
    expect(resp.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
})
