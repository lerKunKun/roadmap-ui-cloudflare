"use client"

import { ExternalLink, LogOut, Map, Pencil, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Project } from "@/features/roadmap/types"

interface AdminToolbarProps {
  projects: Project[]
  selectedProjectId: string
  onProjectChange(projectId: string): void
  onCreateProject(): void
  onEditProject(): void
  onDeleteProject(): void
  onCreateItem(): void
  onLogout(): void
}

export function AdminToolbar({
  projects,
  selectedProjectId,
  onProjectChange,
  onCreateProject,
  onEditProject,
  onDeleteProject,
  onCreateItem,
  onLogout,
}: AdminToolbarProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId)

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-[120rem] flex-col gap-4 px-4 py-5 sm:px-6 xl:flex-row xl:items-center xl:justify-between lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-blue-500/20">
            <Map className="size-5" />
          </div>
          <div>
            <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">Roadmap Admin</p>
            <h1 className="text-xl font-semibold tracking-tight">路线图管理</h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {projects.length > 0 ? (
            <label className="sr-only" htmlFor="admin-project">切换项目</label>
          ) : null}
          {projects.length > 0 ? (
            <select
              id="admin-project"
              aria-label="切换项目"
              value={selectedProjectId}
              onChange={(event) => onProjectChange(event.target.value)}
              className="h-9 min-w-40 rounded-lg border border-input bg-background px-2.5 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          ) : null}

          <Button variant="outline" onClick={onCreateProject}>
            <Plus data-icon="inline-start" />项目
          </Button>
          <Button variant="outline" onClick={onEditProject} disabled={!selectedProject} aria-label="编辑当前项目">
            <Pencil />
          </Button>
          <Button variant="outline" onClick={onDeleteProject} disabled={!selectedProject} aria-label="删除当前项目">
            <Trash2 />
          </Button>
          <Button onClick={onCreateItem} disabled={!selectedProject}>
            <Plus data-icon="inline-start" />Roadmap 条目
          </Button>
          {selectedProject?.projectUrl ? (
            <Button nativeButton={false} variant="ghost" render={<a href={selectedProject.projectUrl} target="_blank" rel="noreferrer" />} aria-label="打开项目网址">
              <ExternalLink />
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onLogout} aria-label="退出管理端">
            <LogOut />
          </Button>
        </div>
      </div>
    </header>
  )
}
