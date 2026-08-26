"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { listRoadmapStatusHistory } from "@/features/roadmap/api"
import type { RoadmapStatusHistoryEntry } from "@/features/roadmap/types"

export interface RoadmapHistoryState {
  entries: RoadmapStatusHistoryEntry[]
  loading: boolean
  error: string | null
  retry(): void
}

export function useRoadmapHistory(itemId: string | null): RoadmapHistoryState {
  const [stateItemId, setStateItemId] = useState(itemId)
  const [entries, setEntries] = useState<RoadmapStatusHistoryEntry[]>([])
  const [loading, setLoading] = useState(Boolean(itemId))
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const requestVersion = useRef(0)

  useEffect(() => {
    const currentVersion = requestVersion.current + 1
    requestVersion.current = currentVersion

    if (!itemId) {
      void Promise.resolve().then(() => {
        if (requestVersion.current === currentVersion) {
          setStateItemId(null)
          setEntries([])
          setLoading(false)
          setError(null)
        }
      })
    } else {
      const historyRequest = listRoadmapStatusHistory(itemId)

      void Promise.resolve().then(() => {
        if (requestVersion.current === currentVersion) {
          setStateItemId(itemId)
          setEntries([])
          setLoading(true)
          setError(null)
        }
      })

      void historyRequest
        .then((nextEntries) => {
          if (requestVersion.current === currentVersion) {
            setEntries(nextEntries)
          }
        })
        .catch((loadError: unknown) => {
          if (requestVersion.current === currentVersion) {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "状态时间轴加载失败，请稍后重试"
            )
          }
        })
        .finally(() => {
          if (requestVersion.current === currentVersion) {
            setLoading(false)
          }
        })
    }

    return () => {
      if (requestVersion.current === currentVersion) {
        requestVersion.current += 1
      }
    }
  }, [itemId, retryToken])

  const retry = useCallback(() => {
    if (itemId) {
      setRetryToken((current) => current + 1)
    }
  }, [itemId])

  if (!itemId) {
    return { entries: [], loading: false, error: null, retry }
  }

  return stateItemId === itemId
    ? { entries, loading, error, retry }
    : { entries: [], loading: true, error: null, retry }
}
