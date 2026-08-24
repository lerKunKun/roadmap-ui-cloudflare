import { FolderKanban } from "lucide-react"

import type { Project } from "@/features/roadmap/types"

interface ProjectSwitcherProps {
  projects: Project[]
  value: string
  onValueChange(projectId: string): void
}

export function ProjectSwitcher({
  projects,
  value,
  onValueChange,
}: ProjectSwitcherProps) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background px-2.5 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      <FolderKanban className="size-4 text-primary" />
      <label htmlFor="project-switcher" className="sr-only">
        切换项目
      </label>
      <select
        id="project-switcher"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="min-w-28 bg-transparent text-sm font-medium outline-none sm:min-w-36"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </div>
  )
}
