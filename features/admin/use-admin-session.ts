"use client"

import { useCallback, useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseBrowserClient } from "@/lib/supabase/browser"

const DEFAULT_ADMIN_EMAIL = "roadmap-admin@internal.invalid"
let handoff: Promise<void> | undefined

function completeWorkbenchSignIn(): Promise<void> {
  const url = new URL(window.location.href)
  const mode = url.searchParams.get("workbench")
  if (!mode) return handoff ?? Promise.resolve()
  url.searchParams.delete("workbench")
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash)
  if (mode !== "finish") return Promise.reject(new Error(mode === "disabled" ? "工作台单点登录尚未启用，请使用管理密码。" : "工作台单点登录未完成，请重试或使用管理密码。"))
  handoff = (async () => {
    const response = await fetch("/workbench/api/sso/session", { method: "POST", cache: "no-store", redirect: "error" })
    if (!response.ok) throw new Error("工作台登录已失效，请重试或使用管理密码。")
    const { access_token, refresh_token } = await response.json()
    const { error } = await getSupabaseBrowserClient().auth.setSession({ access_token, refresh_token })
    if (error) throw new Error("无法建立 Roadmap 会话，请使用管理密码。")
  })()
  return handoff
}

export async function sendToWorkbench(itemId: string, summary: string) {
  const { data } = await getSupabaseBrowserClient().auth.getSession()
  if (!isAdminSession(data.session) || !data.session) throw new Error("请先登录 Roadmap 管理端")
  const response = await fetch("/workbench/api/feedback", {
    method: "POST", redirect: "error", headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, summary }),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "工作台未确认接收，可安全重试")
}

function adminEmail() {
  return process.env.NEXT_PUBLIC_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL
}

export function isAdminSession(
  session: { user?: { email?: string } } | null,
) {
  return session?.user?.email === adminEmail()
}

export async function signInAdmin(password: string): Promise<Session | null> {
  const { data, error } = await getSupabaseBrowserClient().auth.signInWithPassword({
    email: adminEmail(),
    password,
  })

  if (error) {
    if (/invalid login credentials/i.test(error.message)) {
      throw new Error("密码不正确")
    }
    throw new Error("登录失败，请稍后重试")
  }

  return data.session
}

export async function signOutAdmin(): Promise<void> {
  const { error } = await getSupabaseBrowserClient().auth.signOut()
  if (error) throw new Error("退出失败，请稍后重试")
}

export function useAdminSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const client = getSupabaseBrowserClient()
    let active = true

    void (async () => {
      try { await completeWorkbenchSignIn() } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "工作台单点登录未完成")
      }
      const { data } = await client.auth.getSession()
      if (active) {
        setSession(data.session)
        setChecking(false)
      }
    })()

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  const login = useCallback(async (password: string) => {
    setPending(true)
    setError(null)
    try {
      setSession(await signInAdmin(password))
    } catch (loginError) {
      const message =
        loginError instanceof Error ? loginError.message : "登录失败"
      setError(message)
      throw loginError
    } finally {
      setPending(false)
    }
  }, [])

  const logout = useCallback(async () => {
    await signOutAdmin()
    setSession(null)
  }, [])

  return {
    authenticated: isAdminSession(session),
    checking,
    pending,
    error,
    login,
    logout,
  }
}
