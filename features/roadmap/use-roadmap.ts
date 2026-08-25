"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  listProjects,
  listRoadmapItems,
  submitSuggestion,
  voteForItem,
} from "@/features/roadmap/api"
import type {
  Project,
  RoadmapItem,
  SuggestionInput,
} from "@/features/roadmap/types"

export function useRoadmap() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [items, setItems] = useState<RoadmapItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [votingItemId, setVotingItemId] = useState<string | null>(null)

  const loadAvailableProjects = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const availableProjects = await listProjects()
      setProjects(availableProjects)
      setSelectedProjectId((current) =>
        availableProjects.some((project) => project.id === current)
          ? current
          : (availableProjects[0]?.id ?? ""),
      )
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "项目列表加载失败，请稍后重试",
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(loadAvailableProjects)
  }, [loadAvailableProjects])

  const reload = useCallback(async () => {
    if (!selectedProjectId) {
      setItems([])
      await loadAvailableProjects()
      return
    }

    setLoading(true)
    setError(null)

    try {
      setItems(await listRoadmapItems(selectedProjectId))
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Roadmap 加载失败，请稍后重试",
      )
    } finally {
      setLoading(false)
    }
  }, [loadAvailableProjects, selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) {
      return
    }

    let active = true

    async function loadSelectedRoadmap() {
      setLoading(true)
      setError(null)

      try {
        const selectedItems = await listRoadmapItems(selectedProjectId)

        if (active) {
          setItems(selectedItems)
        }
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Roadmap 加载失败，请稍后重试",
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadSelectedRoadmap()

    return () => {
      active = false
    }
  }, [selectedProjectId])

  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const submit = useCallback(
    async (input: SuggestionInput) => {
      await submitSuggestion(input)
      setNotice("建议已提交，感谢你的反馈")

      if (input.projectId === selectedProjectId) {
        try {
          setItems(await listRoadmapItems(selectedProjectId))
        } catch {
          setNotice("建议已提交，但列表刷新失败")
        }
      }
    },
    [selectedProjectId],
  )

  const vote = useCallback(async (itemId: string) => {
    setVotingItemId(itemId)

    try {
      const result = await voteForItem(itemId)
      setItems((currentItems) =>
        currentItems.map((item) =>
          item.id === itemId ? { ...item, voteCount: result.voteCount } : item,
        ),
      )
      setNotice(
        result.duplicate
          ? "当前网络已投过票"
          : "投票成功，感谢你的反馈",
      )
    } catch (voteError) {
      setNotice(
        voteError instanceof Error ? voteError.message : "投票失败，请稍后重试",
      )
    } finally {
      setVotingItemId(null)
    }
  }, [])

  return {
    projects,
    selectedProject,
    selectedProjectId,
    items,
    loading,
    error,
    notice,
    votingItemId,
    setSelectedProjectId,
    reload,
    submit,
    vote,
    clearNotice: () => setNotice(null),
  }
}
