"use client"

import { useState, type FormEvent } from "react"
import { LockKeyhole, Map } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface AdminLoginProps {
  onSubmit(password: string): Promise<void>
  pending: boolean
  error: string | null
}

export function AdminLogin({ onSubmit, pending, error }: AdminLoginProps) {
  const [password, setPassword] = useState("")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password) return
    await onSubmit(password).catch(() => undefined)
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <section className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-xl shadow-blue-950/5 sm:p-8">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-blue-500/20">
            <Map className="size-5" />
          </div>
          <div>
            <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">
              Roadmap
            </p>
            <h1 className="text-xl font-semibold tracking-tight">管理端登录</h1>
          </div>
        </div>

        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          使用管理员强密码进入项目与 Roadmap 管理工作区。
        </p>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-password">管理密码</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                className="pl-9"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoFocus
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="lg" disabled={pending || !password}>
            {pending ? "正在验证…" : "进入管理端"}
          </Button>
        </form>

        <Link
          href="/"
          className="mt-6 block text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          返回公开路线图
        </Link>
      </section>
    </main>
  )
}
