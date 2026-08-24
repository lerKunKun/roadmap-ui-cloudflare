"use client"

import { useCallback, useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"

import { getSupabaseBrowserClient } from "@/lib/supabase/browser"

const DEFAULT_ADMIN_EMAIL = "roadmap-admin@internal.invalid"

function adminEmail() {
  return process.env.NEXT_PUBLIC_ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL
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
    authenticated: Boolean(session),
    checking,
    pending,
    error,
    login,
    logout,
  }
}
