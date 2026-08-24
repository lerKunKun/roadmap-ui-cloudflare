import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let browserClient: SupabaseClient | undefined

export function getSupabaseBrowserClient(): SupabaseClient {
  if (browserClient) {
    return browserClient
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!url || !publishableKey) {
    throw new Error("Roadmap 尚未配置 Supabase 连接")
  }

  browserClient = createClient(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  })

  return browserClient
}
