"use client"

import { useRef, useState, type FormEvent } from "react"
import { Lightbulb, Plus } from "lucide-react"

import { SuggestionImageField } from "@/components/roadmap/suggestion-image-field"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { Project, SuggestionInput } from "@/features/roadmap/types"

interface SuggestionDialogProps {
  projects: Project[]
  selectedProjectId: string
  onSubmit(input: SuggestionInput): Promise<void>
}

export function SuggestionDialog({
  projects,
  selectedProjectId,
  onSubmit,
}: SuggestionDialogProps) {
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState(selectedProjectId)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [image, setImage] = useState<File | null>(null)
  const [imageValidating, setImageValidating] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imageValidatingRef = useRef(false)
  const submittingRef = useRef(false)

  function resetForm() {
    setProjectId(selectedProjectId)
    setTitle("")
    setDescription("")
    setImage(null)
    imageValidatingRef.current = false
    setImageValidating(false)
    setError(null)
  }

  function handleImageValidatingChange(validating: boolean) {
    imageValidatingRef.current = validating
    setImageValidating(validating)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (pending && !nextOpen) return

    if (nextOpen) {
      setProjectId(selectedProjectId)
      setError(null)
    } else {
      resetForm()
    }

    setOpen(nextOpen)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (submittingRef.current || imageValidatingRef.current) return

    const cleanTitle = title.trim()
    const cleanDescription = description.trim()

    if (cleanTitle.length < 2) {
      setError("建议标题至少需要 2 个字符")
      return
    }

    submittingRef.current = true
    setPending(true)
    setError(null)

    try {
      await onSubmit({
        projectId,
        title: cleanTitle,
        description: cleanDescription,
        image,
      })
      resetForm()
      setOpen(false)
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "建议提交失败"
      )
    } finally {
      submittingRef.current = false
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button size="lg" disabled={projects.length === 0} />}
      >
        <Plus data-icon="inline-start" />
        提交建议
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-blue-50 text-primary dark:bg-blue-950">
            <Lightbulb className="size-4" />
          </div>
          <DialogTitle>提交 Roadmap 建议</DialogTitle>
          <DialogDescription>
            你的建议会先进入“待处理”，管理员确认后再安排后续阶段。
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-1.5">
            <Label htmlFor="suggestion-project">所属项目</Label>
            <select
              id="suggestion-project"
              className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={pending}
              required
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="suggestion-title">建议标题</Label>
              <span className="text-[0.7rem] text-muted-foreground tabular-nums">
                {title.length}/120
              </span>
            </div>
            <Input
              id="suggestion-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              minLength={2}
              maxLength={120}
              placeholder="用一句话说明你希望增加的能力"
              disabled={pending}
              required
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="suggestion-description">详细说明</Label>
              <span className="text-[0.7rem] text-muted-foreground tabular-nums">
                {description.length}/4000
              </span>
            </div>
            <Textarea
              id="suggestion-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4000}
              placeholder="补充使用场景、期望结果或当前遇到的问题"
              className="min-h-28 resize-y"
              disabled={pending}
            />
          </div>

          <SuggestionImageField
            value={image}
            onChange={setImage}
            onValidatingChange={handleImageValidatingChange}
            disabled={pending}
          />

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="mt-1">
            <Button
              type="submit"
              disabled={pending || imageValidating || !projectId}
            >
              {pending ? "正在上传…" : "确认提交"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
