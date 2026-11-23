const adminOrigin = "https://admin.telljax.com"
const workbenchOrigin = "https://kb.biounetwork.com"
const workbenchAPI = `${workbenchOrigin}/api/integrations/roadmap`
const requestCookie = "__Host-wb-roadmap-request"
const otpCookie = "__Host-wb-roadmap-otp"
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const nonce = /^[A-Za-z0-9_-]{43}$/
// Supabase Auth GenerateTokenHash uses SHA-224, encoded in lowercase hex.
const tokenHash = /^[a-f0-9]{56}$/
const noStore = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
}

interface Env {
  SUPABASE_URL?: string
  SUPABASE_PUBLISHABLE_KEY?: string
  SUPABASE_SECRET_KEY?: string
  WORKBENCH_SUPABASE_ADMIN_ID?: string
  WORKBENCH_SUPABASE_ADMIN_EMAIL?: string
  WORKBENCH_SSO_KEY?: string
  WORKBENCH_FEEDBACK_KEY?: string
  WORKBENCH_FEEDBACK_MODE?: string
  WORKBENCH_DISPATCH_KEY?: string
}
export interface BridgeContext {
  request: Request
  env: Env
}

function json(status: number, value: object) {
  return Response.json(value, { status, headers: noStore })
}
function error(status: number, message: string) {
  return json(status, { error: message })
}
function redirect(location: string, ...cookies: string[]) {
  const headers = new Headers({ ...noStore, Location: location })
  for (const cookie of cookies) headers.append("Set-Cookie", cookie)
  return new Response(null, { status: 303, headers })
}
function cookie(name: string, value: string, age: number) {
  return `${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`
}
function readCookie(req: Request, name: string) {
  return (
    (req.headers.get("cookie") ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ""
  )
}
function ownHost(req: Request) {
  return new URL(req.url).origin === adminOrigin
}
function ownOrigin(req: Request) {
  return ownHost(req) && req.headers.get("origin") === adminOrigin
}
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}
function secret(value: string | undefined): value is string {
  return !!value && value.length >= 32
}
function supabase(env: Env) {
  return (
    /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(env.SUPABASE_URL ?? "") &&
    env.SUPABASE_PUBLISHABLE_KEY &&
    uuid.test(env.WORKBENCH_SUPABASE_ADMIN_ID ?? "") &&
    env.WORKBENCH_SUPABASE_ADMIN_EMAIL
  )
}
function ssoEnabled(env: Env) {
  return (
    supabase(env) &&
    env.SUPABASE_SECRET_KEY &&
    secret(env.WORKBENCH_SSO_KEY) &&
    env.WORKBENCH_SSO_KEY !== env.WORKBENCH_FEEDBACK_KEY
  )
}
function boundUser(value: unknown, env: Env) {
  if (!value || typeof value !== "object") return false
  const user = value as { id?: unknown; email?: unknown }
  return (
    user.id === env.WORKBENCH_SUPABASE_ADMIN_ID &&
    user.email === env.WORKBENCH_SUPABASE_ADMIN_EMAIL
  )
}
function sb(env: Env, path: string) {
  return `${env.SUPABASE_URL!.replace(/\/$/, "")}${path}`
}
function secureFetch(
  upstream: typeof fetch,
  url: string,
  init: RequestInit = {}
) {
  return upstream.call(globalThis, url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  })
}
function jsonPost(token: string, value: object): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  }
}

export async function ssoStart(req: Request, env: Env) {
  if (!ownHost(req)) return error(404, "Not found")
  if (!ssoEnabled(env)) return redirect("/admin/?workbench=disabled")
  const state = encode(crypto.getRandomValues(new Uint8Array(32)))
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  )
  return redirect(
    `${workbenchAPI}/sso/authorize?${new URLSearchParams({ state, challenge })}`,
    cookie(requestCookie, `${state}.${verifier}`, 600)
  )
}

export async function ssoCallback(req: Request, env: Env, upstream = fetch) {
  if (!ownHost(req)) return error(404, "Not found")
  const clear = cookie(requestCookie, "", 0)
  const fail = (stage: string) => {
    const response = redirect("/admin/?workbench=error", clear)
    response.headers.set("Server-Timing", `roadmap_${stage}`)
    return response
  }
  if (!ssoEnabled(env)) return fail("configuration")
  const [state, verifier] = readCookie(req, requestCookie).split(".")
  const q = new URL(req.url).searchParams
  const grant = q.get("grant") ?? ""
  if (
    !nonce.test(state ?? "") ||
    state !== q.get("state") ||
    !nonce.test(verifier ?? "") ||
    !nonce.test(grant)
  )
    return fail("browser_state")
  let stage = "workbench_exchange"
  try {
    const grantResponse = await secureFetch(
      upstream,
      `${workbenchAPI}/sso/exchange`,
      jsonPost(env.WORKBENCH_SSO_KEY!, { grant, verifier })
    )
    if (!grantResponse.ok || (await grantResponse.json()).ok !== true)
      return fail(`workbench_exchange_${grantResponse.status}`)
    stage = "provider_issue"
    const key = env.SUPABASE_SECRET_KEY!
    const minted = await secureFetch(
      upstream,
      sb(env, "/auth/v1/admin/generate_link"),
      {
        method: "POST",
        headers: {
          apikey: key,
          ...(key.startsWith("sb_secret_")
            ? {}
            : { Authorization: `Bearer ${key}` }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "magiclink",
          email: env.WORKBENCH_SUPABASE_ADMIN_EMAIL,
          redirect_to: `${adminOrigin}/admin/`,
        }),
      }
    )
    if (!minted.ok) return fail(`provider_issue_${minted.status}`)
    const data = await minted.json()
    const hash = data.hashed_token ?? data.properties?.hashed_token
    if (
      !boundUser(data.user ?? data, env) ||
      typeof hash !== "string" ||
      !tokenHash.test(hash)
    )
      return fail("provider_binding")
    return redirect(
      "/admin/?workbench=finish",
      clear,
      cookie(otpCookie, hash, 60)
    )
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : ""
    const kind = /illegal invocation/i.test(detail)
      ? "invocation"
      : /redirect/i.test(detail)
        ? "redirect"
        : /timeout|aborted/i.test(detail)
          ? "timeout"
          : /json|unexpected token/i.test(detail)
            ? "response"
            : "transport"
    return fail(`${stage}_${kind}`)
  }
}

export async function consumeSession(req: Request, env: Env, upstream = fetch) {
  if (!ownOrigin(req)) return error(403, "来源无效")
  const clear = cookie(otpCookie, "", 0)
  let response = error(401, "单点登录已失效，请重试")
  const hash = readCookie(req, otpCookie)
  if (ssoEnabled(env) && tokenHash.test(hash)) {
    try {
      const verified = await secureFetch(upstream, sb(env, "/auth/v1/verify"), {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "magiclink", token_hash: hash }),
      })
      if (verified.ok) {
        const data = await verified.json()
        if (
          boundUser(data.user, env) &&
          typeof data.access_token === "string" &&
          typeof data.refresh_token === "string"
        ) {
          response = json(200, {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
          })
        }
      }
    } catch {
      /* Password login remains available. */
    }
  }
  response.headers.set("Set-Cookie", clear)
  return response
}

export async function forwardFeedback(
  req: Request,
  env: Env,
  upstream = fetch
) {
  if (!ownOrigin(req)) return error(403, "来源无效")
  const mode = env.WORKBENCH_FEEDBACK_MODE || "direct"
  const key =
    mode === "n8n" ? env.WORKBENCH_DISPATCH_KEY : env.WORKBENCH_FEEDBACK_KEY
  if (
    !supabase(env) ||
    !secret(key) ||
    !["direct", "n8n"].includes(mode) ||
    key === env.WORKBENCH_SSO_KEY
  )
    return error(503, "工作台接入尚未配置")
  const authorization = req.headers.get("authorization") ?? ""
  if (!/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization))
    return error(401, "请先登录")
  let itemId: string
  let summary: string
  try {
    const text = await req.text()
    if (text.length > 14000) return error(400, "条目无效")
    const input = JSON.parse(text)
    itemId = input.itemId
    summary = typeof input.summary === "string" ? input.summary.trim() : ""
    if (typeof itemId !== "string" || !uuid.test(itemId))
      return error(400, "条目无效")
    if (!summary || summary.length > 2000)
      return error(400, "请填写已审核的转交摘要（最多 2000 字）")
  } catch {
    return error(400, "条目无效")
  }
  const headers = {
    apikey: env.SUPABASE_PUBLISHABLE_KEY!,
    Authorization: authorization,
  }
  try {
    const user = await secureFetch(upstream, sb(env, "/auth/v1/user"), {
      headers,
    })
    if (!user.ok || !boundUser(await user.json(), env))
      return error(403, "需要已绑定的 Roadmap 管理员")
    const allowed = await secureFetch(
      upstream,
      sb(env, "/rest/v1/rpc/is_roadmap_admin"),
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      }
    )
    if (!allowed.ok || (await allowed.json()) !== true)
      return error(403, "需要 Roadmap 管理权限")
    const query = new URLSearchParams({
      select: "id,project_id,title,status,vote_count",
      id: `eq.${itemId}`,
      limit: "1",
    })
    const result = await secureFetch(
      upstream,
      sb(env, `/rest/v1/roadmap_items_public?${query}`),
      { headers }
    )
    if (!result.ok) return error(502, "无法读取公开条目")
    const [item] = await result.json()
    if (!item || item.id !== itemId || !uuid.test(item.project_id))
      return error(404, "公开条目不存在")
    if (!["approved", "in_progress", "completed"].includes(item.status))
      return error(409, "请先在 Roadmap 批准该条目，再转交工作台")
    const imported = await secureFetch(
      upstream,
      `${workbenchAPI}/${mode === "n8n" ? "dispatch" : "feedback"}`,
      jsonPost(key, {
        itemId,
        projectId: item.project_id,
        title: item.title,
        summary,
        votes: Number(item.vote_count),
      })
    )
    if (imported.status === 400)
      return error(400, "项目未映射或条目内容不符合要求")
    if (imported.status === 409) return error(409, "条目已属于其他项目映射")
    if (!imported.ok || !uuid.test((await imported.json()).id ?? ""))
      return error(502, "工作台未确认接收，可安全重试")
    return json(200, { ok: true })
  } catch {
    return error(502, "接入暂不可用，可安全重试")
  }
}
