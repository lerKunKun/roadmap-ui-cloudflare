"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { listRoadmapStatusHistory } from "@/features/roadmap/api"
import { listRoadmapReplies } from "@/features/roadmap/replies"
import type { RoadmapReply, RoadmapStatusHistoryEntry } from "@/features/roadmap/types"

export interface RoadmapHistoryState {
  entries: RoadmapStatusHistoryEntry[]
  replies: RoadmapReply[]
  loading: boolean
  error: string | null
  retry(): void
}

export function useRoadmapHistory(itemId: string | null, fromSource = false): RoadmapHistoryState {
  const [stateItemId, setStateItemId] = useState(itemId)
  const [entries, setEntries] = useState<RoadmapStatusHistoryEntry[]>([])
  const [replies, setReplies] = useState<RoadmapReply[]>([])
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
          setReplies([])
          setLoading(false)
          setError(null)
        }
      })
    } else {
      const historyRequest = Promise.all([
        listRoadmapStatusHistory(itemId),
        listRoadmapReplies(itemId, fromSource),
      ])

      void Promise.resolve().then(() => {
        if (requestVersion.current === currentVersion) {
          setStateItemId(itemId)
          setEntries([])
          setReplies([])
          setLoading(true)
          setError(null)
        }
      })

      void historyRequest
        .then(([nextEntries, nextReplies]) => {
          if (requestVersion.current === currentVersion) {
            setEntries(nextEntries)
            setReplies(nextReplies)
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
  }, [itemId, fromSource, retryToken])

  const retry = useCallback(() => {
    if (itemId) {
      setRetryToken((current) => current + 1)
    }
  }, [itemId])

  if (!itemId) {
    return { entries: [], replies: [], loading: false, error: null, retry }
  }

  return stateItemId === itemId
    ? { entries, replies, loading, error, retry }
    : { entries: [], replies: [], loading: true, error: null, retry }
}
