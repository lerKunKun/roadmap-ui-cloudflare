import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { RoadmapReply } from "@/features/roadmap/types"
import { getSupabaseBrowserClient } from "@/lib/supabase/browser"

export const ROADMAP_REPLY_LIMIT = 2000
const sourceUrl = process.env.NEXT_PUBLIC_ADVERTISING_REPLY_SOURCE_URL
const sourceKey = process.env.NEXT_PUBLIC_ADVERTISING_REPLY_SOURCE_KEY
let publicSource: SupabaseClient | undefined

export function usesSourceReplies(projectSlug: string | undefined): boolean {
  return projectSlug === "advertising-system" && Boolean(sourceUrl && sourceKey)
}

function replyClient(fromSource: boolean) {
  if (fromSource && sourceUrl && sourceKey) {
    publicSource ??= createClient(sourceUrl, sourceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    return publicSource
  }
  return getSupabaseBrowserClient()
}

export async function listRoadmapReplies(itemId: string, fromSource: boolean): Promise<RoadmapReply[]> {
  const { data, error } = await replyClient(fromSource)
    .from("roadmap_item_replies")
    .select("id,body,created_at")
    .eq("roadmap_item_id", itemId)
    .order("created_at")
    .order("id")

  if (error) throw new Error("管理员回复加载失败，请稍后重试")
  return (data ?? []).map((row) => ({
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
  }))
}

export async function publishRoadmapReply(itemId: string, value: string): Promise<void> {
  const body = value.trim()
  if (!body || body.length > ROADMAP_REPLY_LIMIT) {
    throw new Error(`请填写 1–${ROADMAP_REPLY_LIMIT} 字的回复`)
  }
  const { error } = await getSupabaseBrowserClient()
    .from("roadmap_item_replies")
    .insert({ roadmap_item_id: itemId, body })
  if (error) throw new Error("回复发布失败，请稍后重试")
}
