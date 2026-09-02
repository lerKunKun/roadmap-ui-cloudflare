import {
  digestAdvertisingSnapshot,
  parseAdvertisingSnapshot,
  type AdvertisingSnapshot,
  type HydratedAdvertisingSnapshot,
} from "./advertising-sync-model.ts"

type ApplyConfirmation = "committed" | "not_committed" | "unknown"

export type AdvertisingSyncDependencies = {
  claim(runId: string): Promise<boolean>
  fetchSnapshot(): Promise<unknown>
  prepareImages(snapshot: AdvertisingSnapshot): Promise<{
    snapshot: unknown
    uploadedPaths: string[]
  }>
  digest(snapshot: unknown): Promise<string>
  apply(
    runId: string,
    snapshot: unknown,
    digest: string,
    durationMs: number,
  ): Promise<{ applied: boolean; cleanupPaths?: string[] }>
  confirmApply(runId: string, digest: string): Promise<ApplyConfirmation>
  fail(
    runId: string,
    code: string,
    message: string,
    durationMs: number,
  ): Promise<void>
  cleanupQueuedObjects(paths?: string[]): Promise<{
    attempted: number
    failed: number
  }>
  compensate(paths: string[]): Promise<void>
  now(): number
  randomUuid(): string
  logger(entry: Record<string, unknown>): void
}

function syncError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error) {
    const candidate = String(error.code)
    if (/^[A-Z][A-Z0-9_]{2,79}$/.test(candidate)) return candidate
  }
  return fallback
}

async function fetchSourceWithOneRetry(
  fetchSnapshot: () => Promise<unknown>,
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchSnapshot()
    } catch (error) {
      lastError = error
    }
  }
  throw syncError(
    errorCode(lastError, "SOURCE_UNAVAILABLE"),
    "源广告系统暂时不可用",
  )
}

export async function runAdvertisingSync(
  dependencies: AdvertisingSyncDependencies,
): Promise<{
  ok: true
  runId: string
  digest: string
  counts: { items: number; histories: number; images: number }
  durationMs: number
  cleanup: { attempted: number; failed: number }
}> {
  const startedAt = dependencies.now()
  const runId = dependencies.randomUuid()
  const claimed = await dependencies.claim(runId)
  if (!claimed) throw syncError("SYNC_BUSY", "广告系统同步正在运行")

  let uploadedPaths: string[] = []
  let preserveUploadedPaths = false
  let phase = "source"
  try {
    dependencies.logger({ runId, stage: "started" })
    const rawSnapshot = await fetchSourceWithOneRetry(dependencies.fetchSnapshot)
    const sourceSnapshot = parseAdvertisingSnapshot(rawSnapshot)

    phase = "images"
    const prepared = await dependencies.prepareImages(sourceSnapshot)
    uploadedPaths = [...prepared.uploadedPaths]
    const hydratedSnapshot = prepared.snapshot as HydratedAdvertisingSnapshot

    phase = "digest"
    const digest = await dependencies.digest(hydratedSnapshot)
    const elapsedBeforeApply = Math.max(0, dependencies.now() - startedAt)

    phase = "apply"
    let applyResult: { applied: boolean; cleanupPaths?: string[] }
    try {
      applyResult = await dependencies.apply(
        runId,
        hydratedSnapshot,
        digest,
        elapsedBeforeApply,
      )
      if (applyResult.applied !== true) {
        throw syncError("TARGET_APPLY_FAILED", "目标数据库未确认同步")
      }
    } catch (error) {
      let confirmation: ApplyConfirmation = "unknown"
      try {
        confirmation = await dependencies.confirmApply(runId, digest)
      } catch {
        confirmation = "unknown"
      }
      if (confirmation === "committed") {
        applyResult = { applied: true }
      } else {
        preserveUploadedPaths = confirmation === "unknown"
        throw syncError(
          errorCode(error, "TARGET_APPLY_FAILED"),
          "目标广告系统替换失败",
        )
      }
    }

    phase = "cleanup"
    const cleanup = await dependencies.cleanupQueuedObjects(
      applyResult.cleanupPaths,
    )
    const durationMs = Math.max(0, dependencies.now() - startedAt)
    const counts = {
      items: sourceSnapshot.items.length,
      histories: sourceSnapshot.histories.length,
      images: sourceSnapshot.images.length,
    }
    dependencies.logger({
      runId,
      stage: "completed",
      digest: digest.slice(0, 12),
      counts,
      cleanupFailed: cleanup.failed,
    })
    return { ok: true, runId, digest, counts, durationMs, cleanup }
  } catch (error) {
    const code = errorCode(
      error,
      phase === "source"
        ? "SOURCE_UNAVAILABLE"
        : phase === "images"
          ? "IMAGE_UNAVAILABLE"
          : "TARGET_APPLY_FAILED",
    )
    if (uploadedPaths.length > 0 && !preserveUploadedPaths) {
      try {
        await dependencies.compensate(uploadedPaths)
      } catch {
        // The primary safe code is retained; cleanup debt is visible in Storage audit.
      }
    }
    const durationMs = Math.max(0, dependencies.now() - startedAt)
    try {
      await dependencies.fail(runId, code, `同步阶段失败：${phase}`, durationMs)
    } catch {
      // Failure-state recording must not leak or replace the primary failure.
    }
    dependencies.logger({ runId, stage: phase, code })
    throw syncError(code, "广告系统同步失败")
  }
}

export const defaultAdvertisingSyncDigest = digestAdvertisingSnapshot
