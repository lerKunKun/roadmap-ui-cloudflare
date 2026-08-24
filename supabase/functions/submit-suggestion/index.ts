import { withSupabase } from "@supabase/server"

import { getCorsHeaders, parseAllowedOrigins } from "../_shared/cors.ts"
import { jsonResponse, withResponseHeaders } from "../_shared/http.ts"
import { getRuntimeEnv } from "../_shared/runtime.ts"
import { suggestionSchema } from "../_shared/validation.ts"

const submitSuggestion = withSupabase(
  { auth: "publishable" },
  async (request, context) => {
    let body: unknown

    try {
      body = await request.json()
    } catch {
      return jsonResponse({ message: "请求内容不是有效的 JSON" }, 400)
    }

    const parsed = suggestionSchema.safeParse(body)

    if (!parsed.success) {
      return jsonResponse({ message: "请检查项目、标题和详细说明" }, 400)
    }

    const { projectId, title, description } = parsed.data
    const { data: project, error: projectError } = await context.supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle()

    if (projectError) {
      return jsonResponse({ message: "暂时无法验证项目，请稍后重试" }, 500)
    }

    if (!project) {
      return jsonResponse({ message: "项目不存在或已被删除" }, 404)
    }

    const { data: item, error: insertError } = await context.supabaseAdmin
      .from("roadmap_items")
      .insert({
        project_id: projectId,
        title,
        description,
        status: "pending",
      })
      .select("id")
      .single()

    if (insertError || !item) {
      return jsonResponse({ message: "建议提交失败，请稍后重试" }, 500)
    }

    return jsonResponse({ itemId: item.id }, 201)
  },
)

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

    return withResponseHeaders(await submitSuggestion(request), corsHeaders)
  },
}

export default edgeFunction
