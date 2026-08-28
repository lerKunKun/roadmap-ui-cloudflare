"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ImageLightbox } from "@/components/roadmap/image-lightbox"
import { Skeleton } from "@/components/ui/skeleton"
import type { RoadmapItem } from "@/features/roadmap/types"

interface ItemImageProps {
  item: RoadmapItem
}

type ImageState = "loading" | "loaded" | "error"

export function ItemImage({ item }: ItemImageProps) {
  const [retryKey, setRetryKey] = useState(0)
  const [imageState, setImageState] = useState<ImageState>("loading")

  if (!item.hasImage) return null

  if (item.status === "pending" || item.status === "rejected") {
    return (
      <section
        aria-label="建议图片"
        className="mb-5 rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground"
      >
        {item.status === "pending"
          ? "图片正在审核，通过后将在此显示"
          : "图片未通过审核，不对外显示"}
      </section>
    )
  }

  if (!item.imageId) return null

  const imageUrl = `/media/${item.imageId}`

  return (
    <section
      aria-label="建议图片"
      className="relative mb-5 flex min-h-52 items-center justify-center overflow-hidden rounded-lg border bg-muted/30"
    >
      {imageState === "loading" ? (
        <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
      ) : null}
      {imageState === "error" ? (
        <div className="flex min-h-52 flex-col items-center justify-center gap-3 p-5 text-center">
          <p className="text-sm text-destructive">图片加载失败，请重试</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setImageState("loading")
              setRetryKey((key) => key + 1)
            }}
          >
            重新加载
          </Button>
        </div>
      ) : (
        <ImageLightbox
          src={imageUrl}
          alt={`${item.title} 的建议图片`}
          title={`${item.title} 大图`}
          triggerLabel={`查看“${item.title}”大图`}
          disabled={imageState !== "loaded"}
        >
          {/* The canonical media URL and native load/error lifecycle are part of this component's contract. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={retryKey}
            src={imageUrl}
            alt={`${item.title} 的建议图片`}
            loading="lazy"
            className={`max-h-72 w-full object-contain ${
              imageState === "loaded" ? "opacity-100" : "opacity-0"
            }`}
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("error")}
          />
        </ImageLightbox>
      )}
    </section>
  )
}
