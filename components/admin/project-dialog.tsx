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
import type { ProjectInput } from "@/features/roadmap/admin-api"
import type { Project } from "@/features/roadmap/types"

interface ProjectDialogProps {
  project: Project | null
  nextSortOrder: number
  onOpenChange(open: boolean): void
  onSave(input: ProjectInput): Promise<void>
}

export function ProjectDialog({
  project,
  nextSortOrder,
  onOpenChange,
  onSave,
}: ProjectDialogProps) {
  const [name, setName] = useState(project?.name ?? "")
  const [slug, setSlug] = useState(project?.slug ?? "")
  const [projectUrl, setProjectUrl] = useState(project?.projectUrl ?? "")
  const [sortOrder, setSortOrder] = useState(project?.sortOrder ?? nextSortOrder)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await onSave({
        name,
        slug,
        projectUrl,
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{project ? "编辑项目" : "添加项目"}</DialogTitle>
          <DialogDescription>
            每个项目拥有一套独立 Roadmap；项目网址可暂时留空。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">项目名称</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-slug">项目标识</Label>
            <Input
              id="project-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="example-project"
              required
            />
            <p className="text-xs text-muted-foreground">
              仅小写字母、数字和连字符，创建后仍可修改。
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-url">项目网址</Label>
            <Input
              id="project-url"
              inputMode="url"
              value={projectUrl}
              onChange={(event) => setProjectUrl(event.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-sort-order">项目排序</Label>
            <Input
              id="project-sort-order"
              type="number"
              min={0}
              step={1}
              value={sortOrder}
              onChange={(event) => setSortOrder(Number(event.target.value))}
              required
            />
            <p className="text-xs text-muted-foreground">数字越小，在项目切换器中越靠前。</p>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "保存中…" : "保存项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
