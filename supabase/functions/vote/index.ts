import { withSupabase } from "@supabase/server"

import { getCorsHeaders, parseAllowedOrigins } from "../_shared/cors.ts"
import { jsonResponse, withResponseHeaders } from "../_shared/http.ts"
import { getRuntimeEnv } from "../_shared/runtime.ts"
import { hashIp, normalizeIp } from "../_shared/vote-security.ts"
import { voteSchema } from "../_shared/validation.ts"

const vote = withSupabase({ auth: "publishable" }, async (request, context) => {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    return jsonResponse({ message: "请求内容不是有效的 JSON" }, 400)
  }

  const parsed = voteSchema.safeParse(body)

  if (!parsed.success) {
    return jsonResponse({ message: "Roadmap 条目标识无效" }, 400)
  }

  const sourceIp = request.headers.get("cf-connecting-ip")

  if (!sourceIp) {
    return jsonResponse({ message: "无法识别当前网络，暂时不能投票" }, 400)
  }

  const salt = getRuntimeEnv("VOTE_IP_SALT")

  if (!salt) {
    return jsonResponse({ message: "投票服务尚未配置" }, 500)
  }

  let ipHash: string

  try {
    ipHash = await hashIp(normalizeIp(sourceIp), salt)
  } catch {
    return jsonResponse({ message: "无法识别当前网络，暂时不能投票" }, 400)
  }

  const { roadmapItemId } = parsed.data
  const { error: insertError } = await context.supabaseAdmin.from("votes").insert({
    roadmap_item_id: roadmapItemId,
    ip_hash: ipHash,
  })

  if (insertError && insertError.code === "23503") {
    return jsonResponse({ message: "Roadmap 条目不存在或已被删除" }, 404)
  }

  if (insertError && insertError.code !== "23505") {
    return jsonResponse({ message: "投票失败，请稍后重试" }, 500)
  }

  const { data: item, error: countError } = await context.supabaseAdmin
    .from("roadmap_items_public")
    .select("vote_count")
    .eq("id", roadmapItemId)
    .single()

  if (countError || !item) {
    return jsonResponse({ message: "投票结果读取失败，请刷新重试" }, 500)
  }

  return jsonResponse({
    voteCount: Number(item.vote_count),
    duplicate: insertError?.code === "23505",
  }, 200)
})

const edgeFunction = {
  async fetch(request: Request): Promise<Response> {
    const allowedOrigins = parseAllowedOrigins(
      getRuntimeEnv("ALLOWED_ORIGINS"),
    )
    const corsHeaders = getCorsHeaders(
      request.headers.get("origin"),
      allowedOrigins,
    )

    if (!corsHeaders) {
      return jsonResponse({ message: "请求来源不被允许" }, 403)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (request.method !== "POST") {
      return jsonResponse({ message: "仅支持 POST 请求" }, 405, corsHeaders)
    }

    return withResponseHeaders(await vote(request), corsHeaders)
  },
}

export default edgeFunction
