import { withSupabase } from "@supabase/server"

import { getCorsHeaders, parseAllowedOrigins } from "../_shared/cors.ts"
import { jsonResponse, withResponseHeaders } from "../_shared/http.ts"
import { getRuntimeEnv } from "../_shared/runtime.ts"
import {
  parseSuggestionRequest,
  validateSuggestionImage,
  type ParsedSuggestionRequest,
  type ValidatedSuggestionImage,
} from "../_shared/suggestion-image.ts"
import {
  SuggestionSubmissionError,
  submitSuggestionWithOptionalImage,
  type SuggestionImageRepository,
} from "../_shared/suggestion-upload.ts"
import { hashIp, normalizeIp } from "../_shared/vote-security.ts"

const submitSuggestion = withSupabase(
  { auth: "publishable" },
  async (request, context) => {
    let parsedRequest: ParsedSuggestionRequest

    try {
      parsedRequest = await parseSuggestionRequest(request)
    } catch (error) {
      return jsonResponse(
        {
          message:
            error instanceof Error ? error.message : "请求内容格式不正确",
        },
        400,
      )
    }

    const { projectId, title, description, image } = parsedRequest
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

    const sourceIp = request.headers.get("cf-connecting-ip")
    const salt = getRuntimeEnv("VOTE_IP_SALT")

    if (!sourceIp) {
      return jsonResponse({ message: "无法识别当前网络，暂时不能提交建议" }, 400)
    }

    if (!salt) {
      return jsonResponse({ message: "建议服务尚未配置" }, 500)
    }

    let normalizedIp: string
    let quotaHash: string

    try {
      normalizedIp = normalizeIp(sourceIp)
      quotaHash = await hashIp(normalizedIp, `suggestion:${salt}`)
    } catch {
      return jsonResponse({ message: "无法识别当前网络，暂时不能提交建议" }, 400)
    }

    const { data: quotaAvailable, error: quotaError } =
      await context.supabaseAdmin.rpc("consume_suggestion_quota", {
        target_ip_hash: quotaHash,
        max_allowed: 10,
      })

    if (quotaError) {
      return jsonResponse({ message: "暂时无法校验提交频率，请稍后重试" }, 500)
    }

    if (!quotaAvailable) {
      return jsonResponse({ message: "当前网络提交过于频繁，请一小时后再试" }, 429)
    }

    let validatedImage: ValidatedSuggestionImage | null = null
    let imageIpHash: string | null = null
    if (image) {
      try {
        validatedImage = await validateSuggestionImage(image)
      } catch (error) {
        return jsonResponse(
          {
            message:
              error instanceof Error ? error.message : "建议图片格式不正确",
          },
          400,
        )
      }

      try {
        imageIpHash = await hashIp(normalizedIp, `suggestion-image:${salt}`)
      } catch {
        return jsonResponse({ message: "建议图片上传失败，请稍后重试" }, 502)
      }
    }

    const repository: SuggestionImageRepository = {
      async createItem(input) {
        const { data: item, error: insertError } = await context.supabaseAdmin
          .from("roadmap_items")
          .insert({
            project_id: input.projectId,
            title: input.title,
            description: input.description,
            status: "pending",
          })
          .select("id")
          .single()

        if (insertError || !item)
          throw new Error("suggestion_item_create_failed")
        return item.id
      },
      async consumeImageQuota(ipHash) {
        const { data, error } = await context.supabaseAdmin.rpc(
          "consume_suggestion_image_quota",
          { client_ip_hash: ipHash, quota_limit: 3 },
        )
        if (error) throw error
        return data === true
      },
      async createImageMetadata(input) {
        const { error } = await context.supabaseAdmin
          .from("roadmap_item_images")
          .insert({
            id: input.imageId,
            roadmap_item_id: input.itemId,
            storage_path: input.storagePath,
            mime_type: input.mimeType,
            size_bytes: input.sizeBytes,
            width: input.width,
            height: input.height,
          })
        if (error) throw error
      },
      async uploadImage(path, bytes, mimeType) {
        const { error } = await context.supabaseAdmin.storage
          .from("roadmap-images")
          .upload(path, bytes, {
            contentType: mimeType,
            upsert: false,
            cacheControl: "0",
          })
        if (error) throw error
      },
      async removeImage(path) {
        const { error } = await context.supabaseAdmin.storage
          .from("roadmap-images")
          .remove([path])
        if (error) throw error
      },
      async removeItem(itemId) {
        const { error } = await context.supabaseAdmin
          .from("roadmap_items")
          .delete()
          .eq("id", itemId)
        if (error) throw error
      },
    }

    try {
      const itemId = await submitSuggestionWithOptionalImage(
        {
          suggestion: { projectId, title, description },
          image: validatedImage,
          imageIpHash,
        },
        repository,
      )
      return jsonResponse({ itemId }, 201)
    } catch (error) {
      if (error instanceof SuggestionSubmissionError) {
        const status =
          error.code === "image_rate"
            ? 429
            : error.code === "image_capacity"
              ? 507
              : 502
        return jsonResponse({ message: error.message }, status)
      }
      return jsonResponse({ message: "建议提交失败，请稍后重试" }, 500)
    }
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
