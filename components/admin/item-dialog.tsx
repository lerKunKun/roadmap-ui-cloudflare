"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"

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
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  getAdminRoadmapItemImage,
  type AdminRoadmapImage,
  type RoadmapItemInput,
} from "@/features/roadmap/admin-api"
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

type PreviewState =
  | { itemId: null; status: "idle"; image: null; error: null }
  | { itemId: string; status: "loading"; image: null; error: null }
  | {
      itemId: string
      status: "loaded"
      image: AdminRoadmapImage | null
      error: null
    }
  | { itemId: string; status: "error"; image: null; error: string }

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
  const [sortOrder, setSortOrder] = useState(item?.sortOrder ?? nextSortOrder)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [preview, setPreview] = useState<PreviewState>(() =>
    item?.hasImage
      ? { itemId: item.id, status: "loading", image: null, error: null }
      : { itemId: null, status: "idle", image: null, error: null }
  )
  const previewRequestId = useRef(0)

  useEffect(() => {
    if (!item?.hasImage) {
      previewRequestId.current += 1
      void Promise.resolve().then(() => {
        setPreview({ itemId: null, status: "idle", image: null, error: null })
      })
      return
    }

    const itemId = item.id
    const requestId = ++previewRequestId.current
    void (async () => {
      setPreview({ itemId, status: "loading", image: null, error: null })
      try {
        const image = await getAdminRoadmapItemImage(itemId)
        if (previewRequestId.current !== requestId) return
        setPreview({ itemId, status: "loaded", image, error: null })
      } catch (loadError) {
        if (previewRequestId.current !== requestId) return
        setPreview({
          itemId,
          status: "error",
          image: null,
          error:
            loadError instanceof Error
              ? loadError.message
              : "建议图片加载失败，请重试",
        })
      }
    })()

    return () => {
      if (previewRequestId.current === requestId) {
        previewRequestId.current += 1
      }
    }
  }, [item?.hasImage, item?.id, previewAttempt])

  const visiblePreview =
    item?.hasImage && preview.itemId === item.id
      ? preview
      : item?.hasImage
        ? {
            itemId: item.id,
            status: "loading" as const,
            image: null,
            error: null,
          }
        : null

  function changeOpen(open: boolean) {
    if (!open) previewRequestId.current += 1
    onOpenChange(open)
  }

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
        sortOrder,
      })
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={changeOpen}>
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
          {visiblePreview &&
          !(visiblePreview.status === "loaded" && !visiblePreview.image) ? (
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">建议图片</p>
              <section
                aria-label="建议图片"
                className="relative flex min-h-52 items-center justify-center overflow-hidden rounded-lg border bg-muted/30"
              >
                {visiblePreview.status === "loading" ? (
                  <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
                ) : visiblePreview.status === "error" ? (
                  <div className="flex min-h-52 flex-col items-center justify-center gap-3 p-5 text-center">
                    <p className="text-sm text-destructive">
                      {visiblePreview.error}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setPreview({
                          itemId: item!.id,
                          status: "loading",
                          image: null,
                          error: null,
                        })
                        setPreviewAttempt((attempt) => attempt + 1)
                      }}
                    >
                      重新加载
                    </Button>
                  </div>
                ) : visiblePreview.image ? (
                  // Signed URLs are short-lived review credentials, never Storage paths.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={visiblePreview.image.signedUrl}
                    alt={`待审核建议图片：${item!.title}`}
                    className="max-h-72 w-full object-contain"
                    onError={() => {
                      setPreview({
                        itemId: item!.id,
                        status: "error",
                        image: null,
                        error: "建议图片加载失败，请重试",
                      })
                    }}
                  />
                ) : null}
              </section>
            </div>
          ) : null}
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
          <div className="grid gap-1.5">
            <Label htmlFor="item-sort-order">同阶段排序</Label>
            <Input
              id="item-sort-order"
              type="number"
              min={0}
              step={1}
              value={sortOrder}
              onChange={(event) => setSortOrder(Number(event.target.value))}
              required
            />
            <p className="text-xs text-muted-foreground">数字越小越靠前，也可在看板中拖动排序。</p>
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
