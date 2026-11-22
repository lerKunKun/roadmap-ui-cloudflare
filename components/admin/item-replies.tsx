"use client"

import { useState, type FormEvent } from "react"

import { ItemTimeline } from "@/components/roadmap/item-timeline"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { publishRoadmapReply, ROADMAP_REPLY_LIMIT } from "@/features/roadmap/replies"
import { buildRoadmapTimeline } from "@/features/roadmap/timeline"
import type { RoadmapItem } from "@/features/roadmap/types"
import { useRoadmapHistory } from "@/features/roadmap/use-roadmap-history"

export function ItemReplies({ item, fromSource }: { item: RoadmapItem; fromSource: boolean }) {
  const history = useRoadmapHistory(item.id, fromSource)
  const [body, setBody] = useState("")
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || fromSource || !body.trim()) return
    setPending(true)
    setMessage(null)
    try {
      await publishRoadmapReply(item.id, body)
      setBody("")
      setMessage({ ok: true, text: "回复已发布到公开时间轴" })
      history.retry()
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "回复发布失败" })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-1 rounded-lg border">
      {fromSource ? (
        <p className="px-4 pt-4 text-sm text-muted-foreground">
          广告系统回复请在{" "}
          <a className="font-medium text-primary underline" href="https://admin.telljax.com/admin/">
            主站管理端
          </a>
          {" "}发布。
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-2 border-b p-4">
          <Label htmlFor="item-reply">管理员回复</Label>
          <Textarea
            id="item-reply"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={ROADMAP_REPLY_LIMIT}
            disabled={pending}
            aria-describedby="item-reply-help"
            required
          />
          <p id="item-reply-help" className="text-xs text-muted-foreground">
            回复会直接公开在条目的进展时间轴。
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="submit" size="sm" disabled={pending || !body.trim()}>
              {pending ? "发布中…" : "发布回复"}
            </Button>
            {message ? (
              <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                {message.text}
              </p>
            ) : null}
          </div>
        </form>
      )}
      <ItemTimeline
        groups={buildRoadmapTimeline(item, history.entries, history.replies)}
        loading={history.loading}
        error={history.error}
        onRetry={history.retry}
      />
    </div>
  )
}
