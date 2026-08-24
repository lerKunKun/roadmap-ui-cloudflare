"use client"

import { useState } from "react"
import {
  ArrowUpRight,
  CircleAlert,
  ExternalLink,
  Map,
  RefreshCw,
  X,
} from "lucide-react"

import { ItemDetails } from "@/components/roadmap/item-details"
import { ProjectSwitcher } from "@/components/roadmap/project-switcher"
import { RoadmapBoard } from "@/components/roadmap/roadmap-board"
import { SuggestionDialog } from "@/components/roadmap/suggestion-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useRoadmap } from "@/features/roadmap/use-roadmap"
import type { RoadmapItem } from "@/features/roadmap/types"

export function RoadmapApp() {
  const roadmap = useRoadmap()
  const [detailItem, setDetailItem] = useState<RoadmapItem | null>(null)

  return (
    <main className="min-h-svh">
      <div className="mx-auto flex min-h-svh max-w-[120rem] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-4 border-b border-border/80 pb-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-blue-500/20">
                <Map className="size-5" />
              </div>
              <div className="min-w-0">
                <p className="mb-0.5 text-xs font-semibold tracking-[0.16em] text-primary uppercase">
                  Product direction
                </p>
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                  Roadmap 路线图
                </h1>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  查看各项目进展，提交你的建议，并为更重要的需求投票。
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {roadmap.projects.length > 0 ? (
                <ProjectSwitcher
                  projects={roadmap.projects}
                  value={roadmap.selectedProjectId}
                  onValueChange={roadmap.setSelectedProjectId}
                />
              ) : null}

              {roadmap.selectedProject?.projectUrl ? (
                <Button
                  variant="outline"
                  size="lg"
                  render={
                    <a
                      href={roadmap.selectedProject.projectUrl}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  项目网址
                  <ExternalLink data-icon="inline-end" />
                </Button>
              ) : null}

              <SuggestionDialog
                projects={roadmap.projects}
                selectedProjectId={roadmap.selectedProjectId}
                onSubmit={roadmap.submit}
              />
            </div>
          </div>

          {roadmap.selectedProject ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              当前查看：
              <span className="font-medium text-foreground">
                {roadmap.selectedProject.name}
              </span>
              {roadmap.selectedProject.projectUrl ? (
                <a
                  href={roadmap.selectedProject.projectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  打开项目
                  <ArrowUpRight className="size-3" />
                </a>
              ) : (
                <span>暂未配置项目网址</span>
              )}
            </div>
          ) : null}
        </header>

        {roadmap.notice ? (
          <div
            role="status"
            className="mb-3 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
          >
            <span className="size-1.5 rounded-full bg-blue-500" />
            <span>{roadmap.notice}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label="关闭提示"
              onClick={roadmap.clearNotice}
            >
              <X />
            </Button>
          </div>
        ) : null}

        <section className="min-h-0 flex-1" aria-label="项目路线图">
          {roadmap.error ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 text-center">
              <CircleAlert className="mb-3 size-7 text-destructive" />
              <h2 className="font-semibold">Roadmap 暂时无法加载</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {roadmap.error}
              </p>
              <Button className="mt-4" variant="outline" onClick={roadmap.reload}>
                <RefreshCw data-icon="inline-start" />
                重新加载
              </Button>
            </div>
          ) : roadmap.loading ? (
            <RoadmapSkeleton />
          ) : roadmap.projects.length === 0 ? (
            <div className="flex min-h-72 items-center justify-center rounded-xl border border-dashed bg-card px-6 text-center text-sm text-muted-foreground">
              尚未创建项目，请由管理员先添加项目。
            </div>
          ) : (
            <RoadmapBoard
              items={roadmap.items}
              votingItemId={roadmap.votingItemId}
              onOpenItem={setDetailItem}
              onVote={roadmap.vote}
            />
          )}
        </section>

        <footer className="mt-auto flex items-center justify-between gap-4 pt-3 text-xs text-muted-foreground">
          <span>公开路线图 · 票数按公网 IP 去重</span>
          <a href="/admin/" className="hover:text-foreground hover:underline">
            管理入口
          </a>
        </footer>
      </div>

      <ItemDetails
        item={detailItem}
        voting={roadmap.votingItemId === detailItem?.id}
        onOpenChange={(open) => {
          if (!open) {
            setDetailItem(null)
          }
        }}
        onVote={roadmap.vote}
      />
    </main>
  )
}

function RoadmapSkeleton() {
  return (
    <div className="roadmap-board grid grid-flow-col gap-3 overflow-hidden">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="min-h-[32rem] rounded-xl border bg-card p-3"
        >
          <div className="mb-4 flex items-center gap-2 border-b pb-3">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="ml-auto h-5 w-7" />
          </div>
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="mt-3 h-28 w-full rounded-xl" />
        </div>
      ))}
    </div>
  )
}
