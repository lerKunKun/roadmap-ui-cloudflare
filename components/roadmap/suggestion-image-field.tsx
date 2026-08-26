"use client"

import { useEffect, useId, useRef, useState, type ChangeEvent } from "react"
import { ImagePlus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { validateSelectedSuggestionImage } from "@/features/roadmap/suggestion-image"

interface SuggestionImageFieldProps {
  value: File | null
  onChange(file: File | null): void
  onValidatingChange?(validating: boolean): void
  disabled?: boolean
}

function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Number((bytes / 1_024).toFixed(1))} KB`
  return `${Number((bytes / 1_048_576).toFixed(1))} MB`
}

export function SuggestionImageField({
  value,
  onChange,
  onValidatingChange,
  disabled = false,
}: SuggestionImageFieldProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLImageElement>(null)
  const validationSequence = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)

  useEffect(() => {
    const preview = previewRef.current
    if (!value || !preview) return

    const objectUrl = URL.createObjectURL(value)
    preview.src = objectUrl

    return () => {
      preview.removeAttribute("src")
      URL.revokeObjectURL(objectUrl)
    }
  }, [value])

  useEffect(
    () => () => {
      validationSequence.current += 1
    },
    []
  )

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files
    event.currentTarget.value = ""

    if (!files || files.length === 0) return
    if (files.length > 1) {
      setError("每条建议只能上传一张图片")
      return
    }

    const file = files[0]
    const request = validationSequence.current + 1
    validationSequence.current = request
    setValidating(true)
    onValidatingChange?.(true)
    setError(null)

    try {
      await validateSelectedSuggestionImage(file)
      if (validationSequence.current === request) {
        onChange(file)
      }
    } catch (validationError) {
      if (validationSequence.current === request) {
        setError(
          validationError instanceof Error
            ? validationError.message
            : "图片验证失败"
        )
      }
    } finally {
      if (validationSequence.current === request) {
        setValidating(false)
        onValidatingChange?.(false)
      }
    }
  }

  function removeImage() {
    validationSequence.current += 1
    setError(null)
    onChange(null)
  }

  const actionsDisabled = disabled || validating

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>附加图片（可选）</Label>
      <div className="rounded-lg border border-dashed border-input bg-muted/30 p-3">
        <Input
          ref={inputRef}
          id={inputId}
          type="file"
          accept=".jpeg,.jpg,.png,image/jpeg,image/png"
          className="sr-only"
          disabled={actionsDisabled}
          onChange={handleFileChange}
        />

        {value ? (
          <div className="flex items-center gap-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background">
              {/* A local blob URL cannot benefit from Next image optimization. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={previewRef}
                alt="所选图片预览"
                className="size-full object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{value.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatByteSize(value.size)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={actionsDisabled}
                onClick={() => inputRef.current?.click()}
              >
                <ImagePlus data-icon="inline-start" />
                更换图片
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={actionsDisabled}
                onClick={removeImage}
              >
                <Trash2 data-icon="inline-start" />
                移除图片
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
              <ImagePlus className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">添加一张说明图片</p>
              <p className="text-xs text-muted-foreground">
                仅支持 JPEG、PNG，严格小于 5MB
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus data-icon="inline-start" />
              选择图片
            </Button>
          </div>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
