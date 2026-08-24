"use client"

import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { RoadmapItemInput } from "@/features/roadmap/admin-api"
import {
  STATUS_COLUMNS,
  type RoadmapItem,
  type RoadmapStatus,
} from "@/features/roadmap/types"

interface ItemDialogProps {
  item: RoadmapItem | null
  projectId: string
  nextSortOrder: number
  onOpenChange(open: boolean): void
  onSave(input: RoadmapItemInput): Promise<void>
}

export function ItemDialog({
  item,
  projectId,
  nextSortOrder,
  onOpenChange,
  onSave,
}: ItemDialogProps) {
  const [title, setTitle] = useState(item?.title ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [status, setStatus] = useState<RoadmapStatus>(item?.status ?? "pending")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onSave({
        projectId,
        title,
        description,
        status,
        sortOrder: item?.sortOrder ?? nextSortOrder,
      })
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item ? "编辑 Roadmap 条目" : "添加 Roadmap 条目"}</DialogTitle>
          <DialogDescription>
            可直接调整阶段；公开用户提交的建议默认进入“待处理”。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor="item-title">标题</Label>
            <Input
              id="item-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              minLength={2}
              maxLength={120}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="item-description">详细说明</Label>
            <Textarea
              id="item-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
              className="min-h-28 resize-y"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="item-status">当前阶段</Label>
            <select
              id="item-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as RoadmapStatus)}
              className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {STATUS_COLUMNS.map((column) => (
                <option key={column.value} value={column.value}>{column.label}</option>
              ))}
            </select>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "保存中…" : "保存条目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
