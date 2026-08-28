"use client"

import type { ReactNode } from "react"
import { Maximize2, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

interface ImageLightboxProps {
  src: string
  alt: string
  title: string
  triggerLabel: string
  disabled?: boolean
  children: ReactNode
}

export function ImageLightbox({
  src,
  alt,
  title,
  triggerLabel,
  disabled = false,
  children,
}: ImageLightboxProps) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={triggerLabel}
            disabled={disabled}
            className="group/lightbox relative flex min-h-52 w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-[inherit] outline-none focus-visible:ring-3 focus-visible:ring-ring/60 disabled:cursor-default"
          />
        }
      >
        {children}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-lg border border-white/15 bg-black/60 text-white shadow-sm transition-opacity sm:opacity-0 sm:group-hover/lightbox:opacity-100 sm:group-focus-visible/lightbox:opacity-100"
        >
          <Maximize2 className="size-3.5" />
        </span>
      </DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-none items-center justify-center overflow-hidden bg-black/95 p-3 text-white ring-white/15 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          查看建议图片大图
        </DialogDescription>
        {/* The lightbox reuses the same cached media or signed preview URL. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${alt}（大图）`}
          className="max-h-full max-w-full object-contain"
        />
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭大图"
              className="absolute top-3 right-3 border border-white/15 bg-black/60 text-white hover:bg-black/80 hover:text-white"
            />
          }
        >
          <XIcon />
        </DialogClose>
      </DialogContent>
    </Dialog>
  )
}
