"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { LoaderCircle, RefreshCw } from "lucide-react"

import { AdminBoard } from "@/components/admin/admin-board"
import { AdminLogin } from "@/components/admin/admin-login"
import { AdminToolbar } from "@/components/admin/admin-toolbar"
import { ItemDialog } from "@/components/admin/item-dialog"
import { ProjectDialog } from "@/components/admin/project-dialog"
import { Button } from "@/components/ui/button"
import { useAdminSession } from "@/features/admin/use-admin-session"
import {
  createProject,
  createRoadmapItem,
  deleteProject,
  deleteRoadmapItem,
  listAdminProjects,
  listAdminRoadmapItems,
  moveRoadmapItem,
  updateProject,
  updateRoadmapItem,
  type ProjectInput,
  type RoadmapItemInput,
} from "@/features/roadmap/admin-api"
import type { Project, RoadmapItem, RoadmapStatus } from "@/features/roadmap/types"

export function AdminApp() {
  const auth = useAdminSession()

  if (auth.checking) {
    return (
      <main className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" />正在检查登录状态…
      </main>
    )
  }

  if (!auth.authenticated) {
    return <AdminLogin onSubmit={auth.login} pending={auth.pending} error={auth.error} />
  }

  return <AdminWorkspace onLogout={auth.logout} />
}

function AdminWorkspace({ onLogout }: { onLogout(): Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [items, setItems] = useState<RoadmapItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [projectEditor, setProjectEditor] = useState<Project | "new" | null>(null)
  const [itemEditor, setItemEditor] = useState<RoadmapItem | "new" | null>(null)
  const [movingItemId, setMovingItemId] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nextProjects = await listAdminProjects()
      setProjects(nextProjects)
      setSelectedProjectId((current) =>
        nextProjects.some((project) => project.id === current)
          ? current
          : (nextProjects[0]?.id ?? ""),
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(loadProjects)
  }, [loadProjects])

  useEffect(() => {
    if (!selectedProjectId) {
      void Promise.resolve().then(() => setItems([]))
      return
    }

    let active = true
    void (async () => {
      setLoading(true)
      try {
        const nextItems = await listAdminRoadmapItems(selectedProjectId)
        if (active) setItems(nextItems)
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "条目加载失败")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [selectedProjectId])

  async function saveProject(input: ProjectInput) {
    const saved = projectEditor === "new"
      ? await createProject(input)
      : await updateProject(projectEditor!.id, input)
    setProjects((current) => {
      const exists = current.some((project) => project.id === saved.id)
      return (exists ? current.map((project) => project.id === saved.id ? saved : project) : [...current, saved])
        .sort((a, b) => a.sortOrder - b.sortOrder)
    })
    setSelectedProjectId(saved.id)
    setNotice(projectEditor === "new" ? "项目已创建" : "项目已更新")
  }

  async function removeProject() {
    if (!selectedProject || !window.confirm(`确定删除项目“${selectedProject.name}”吗？`)) return
    try {
      await deleteProject(selectedProject.id)
      setProjects((current) => current.filter((project) => project.id !== selectedProject.id))
      setSelectedProjectId(projects.find((project) => project.id !== selectedProject.id)?.id ?? "")
      setNotice("项目已删除")
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "项目删除失败")
    }
  }

  async function saveItem(input: RoadmapItemInput) {
    const saved = itemEditor === "new"
      ? await createRoadmapItem(input)
      : await updateRoadmapItem(itemEditor!.id, input)
    await moveRoadmapItem(saved.id, input.status, input.sortOrder)
    setItems(await listAdminRoadmapItems(selectedProjectId))
    setNotice(itemEditor === "new" ? "Roadmap 条目已创建" : "Roadmap 条目已更新")
  }

  async function removeItem(item: RoadmapItem) {
    if (!window.confirm(`确定删除“${item.title}”吗？该条目的投票也会删除。`)) return
    try {
      await deleteRoadmapItem(item.id)
      setItems((current) => current.filter((candidate) => candidate.id !== item.id))
      setNotice("Roadmap 条目已删除")
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "条目删除失败")
    }
  }

  async function moveItem(itemId: string, status: RoadmapStatus, sortOrder: number) {
    const before = items
    setMovingItemId(itemId)
    setItems((current) => current.map((item) => item.id === itemId ? { ...item, status, sortOrder } : item))
    try {
      await moveRoadmapItem(itemId, status, sortOrder)
      setNotice("阶段已更新")
    } catch (moveError) {
      setItems(before)
      setError(moveError instanceof Error ? moveError.message : "阶段更新失败")
      setMovingItemId(null)
      return
    }

    try {
      setItems(await listAdminRoadmapItems(selectedProjectId))
    } catch {
      setNotice("阶段已更新，但列表刷新失败")
    } finally {
      setMovingItemId(null)
    }
  }

  return (
    <main className="min-h-svh bg-muted/20">
      <AdminToolbar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onProjectChange={setSelectedProjectId}
        onCreateProject={() => setProjectEditor("new")}
        onEditProject={() => selectedProject && setProjectEditor(selectedProject)}
        onDeleteProject={() => void removeProject()}
        onCreateItem={() => setItemEditor("new")}
        onLogout={() => void onLogout()}
      />
      <div className="mx-auto max-w-[120rem] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mb-4 flex min-h-8 flex-wrap items-center gap-3 text-sm">
          <p className="font-medium">{selectedProject ? `${selectedProject.name} · ${items.length} 个条目` : "尚未创建项目"}</p>
          <p className="text-xs text-muted-foreground">拖动卡片或使用阶段下拉框调整进度</p>
          {notice ? <p role="status" className="ml-auto text-xs font-medium text-emerald-700">{notice}</p> : null}
        </div>
        {error ? (
          <div role="alert" className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span>{error}</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setError(null); void loadProjects() }}>
              <RefreshCw data-icon="inline-start" />重试
            </Button>
          </div>
        ) : null}
        {loading ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />正在加载管理数据…</div>
        ) : selectedProject ? (
          <AdminBoard items={items} movingItemId={movingItemId} onEdit={setItemEditor} onDelete={(item) => void removeItem(item)} onMove={moveItem} />
        ) : (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed bg-background text-center">
            <p className="text-sm text-muted-foreground">添加第一个项目后即可管理 Roadmap。</p>
            <Button className="mt-4" onClick={() => setProjectEditor("new")}>添加项目</Button>
          </div>
        )}
      </div>

      {projectEditor ? (
        <ProjectDialog
          key={projectEditor === "new" ? "new" : projectEditor.id}
          project={projectEditor === "new" ? null : projectEditor}
          nextSortOrder={projects.length}
          onOpenChange={(open) => { if (!open) setProjectEditor(null) }}
          onSave={saveProject}
        />
      ) : null}
      {itemEditor && selectedProject ? (
        <ItemDialog
          key={itemEditor === "new" ? `new-${selectedProject.id}` : itemEditor.id}
          item={itemEditor === "new" ? null : itemEditor}
          projectId={selectedProject.id}
          nextSortOrder={items.filter((item) => item.status === "pending").length}
          onOpenChange={(open) => { if (!open) setItemEditor(null) }}
          onSave={saveItem}
        />
      ) : null}
    </main>
  )
}
