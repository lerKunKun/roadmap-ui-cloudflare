import { getRuntimeEnv } from "../_shared/runtime.ts"
import {
  defaultAdvertisingSyncDigest,
  runAdvertisingSync,
  type AdvertisingSyncDependencies,
} from "../_shared/advertising-sync-runner.ts"
import {
  assertSourceIdentity,
  hasValidSyncSecret,
  safeSyncError,
} from "../_shared/advertising-sync-security.ts"
import {
  compensateUploadedImages,
  createAdvertisingStorageDependencies,
  prepareAdvertisingImages,
} from "../_shared/advertising-sync-storage.ts"

type GetEnv = (name: string) => string | undefined

export type AdvertisingSyncRuntimeConfig = {
  cronSecret: string
  sourceUrl: string
  sourceSecretKey: string
  sourceProjectRef: string
  targetProjectRef: string
  targetUrl: string
  targetServiceRoleKey: string
}

function runtimeConfigError(): Error & { code: string } {
  return Object.assign(new Error("同步运行配置无效"), {
    code: "SOURCE_IDENTITY_INVALID",
  })
}

export function readAdvertisingSyncRuntimeConfig(
  getEnv: GetEnv = getRuntimeEnv
): AdvertisingSyncRuntimeConfig {
  const required = {
    cronSecret: getEnv("ADVERTISING_SYNC_CRON_SECRET"),
    sourceUrl: getEnv("SOURCE_SUPABASE_URL"),
    sourceSecretKey: getEnv("SOURCE_SUPABASE_SECRET_KEY"),
    sourceProjectRef: getEnv("SOURCE_SUPABASE_PROJECT_REF"),
    targetProjectRef: getEnv("TARGET_SUPABASE_PROJECT_REF"),
    targetUrl: getEnv("SUPABASE_URL"),
    targetServiceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  }
  if (Object.values(required).some((value) => !value)) {
    throw runtimeConfigError()
  }
  const config = required as AdvertisingSyncRuntimeConfig
  if (
    config.cronSecret.length < 32 ||
    !/^[a-z0-9]{20}$/.test(config.targetProjectRef) ||
    config.sourceProjectRef === config.targetProjectRef ||
    config.targetUrl !== `https://${config.targetProjectRef}.supabase.co`
  ) {
    throw runtimeConfigError()
  }
  try {
    assertSourceIdentity(config.sourceUrl, config.sourceProjectRef)
  } catch {
    throw runtimeConfigError()
  }
  return config
}

function serverHeaders(key: string): Headers {
  const headers = new Headers({
    apikey: key,
    "content-type": "application/json",
  })
  if (!key.startsWith("sb_")) {
    headers.set("authorization", `Bearer ${key}`)
  }
  return headers
}

async function readJsonResponse(
  response: Response,
  code: string
): Promise<unknown> {
  if (!response.ok)
    throw Object.assign(new Error("provider request failed"), { code })
  try {
    return await response.json()
  } catch {
    throw Object.assign(new Error("provider response invalid"), { code })
  }
}

function createRuntimeDependencies(
  config: AdvertisingSyncRuntimeConfig,
  fetchImpl: typeof fetch = fetch
): AdvertisingSyncDependencies {
  const storage = createAdvertisingStorageDependencies({
    sourceUrl: config.sourceUrl,
    sourceSecretKey: config.sourceSecretKey,
    targetUrl: config.targetUrl,
    targetSecretKey: config.targetServiceRoleKey,
    fetchImpl,
  })

  async function rpc(
    baseUrl: string,
    key: string,
    functionName: string,
    body: Record<string, unknown>,
    code: string
  ) {
    let response: Response
    try {
      response = await fetchImpl(
        `${baseUrl}/rest/v1/rpc/${encodeURIComponent(functionName)}`,
        {
          method: "POST",
          headers: serverHeaders(key),
          body: JSON.stringify(body),
        }
      )
    } catch {
      throw Object.assign(new Error("provider unavailable"), { code })
    }
    return readJsonResponse(response, code)
  }

  async function targetRpc(
    functionName: string,
    body: Record<string, unknown>,
    code = "TARGET_APPLY_FAILED"
  ) {
    return rpc(
      config.targetUrl,
      config.targetServiceRoleKey,
      functionName,
      body,
      code
    )
  }

  async function listCleanupPaths(): Promise<string[]> {
    const response = await fetchImpl(
      `${config.targetUrl}/rest/v1/roadmap_advertising_sync_object_cleanup?select=storage_path&order=storage_path.asc`,
      { headers: serverHeaders(config.targetServiceRoleKey) }
    )
    const rows = await readJsonResponse(response, "TARGET_APPLY_FAILED")
    return Array.isArray(rows)
      ? rows
          .map((row) =>
            row && typeof row === "object" && "storage_path" in row
              ? String(row.storage_path)
              : ""
          )
          .filter(Boolean)
      : []
  }

  return {
    async claim(runId) {
      return Boolean(
        await targetRpc(
          "claim_advertising_roadmap_sync",
          { run_id: runId },
          "TARGET_APPLY_FAILED"
        )
      )
    },
    fetchSnapshot() {
      return rpc(
        config.sourceUrl,
        config.sourceSecretKey,
        "export_advertising_roadmap_snapshot",
        {},
        "SOURCE_UNAVAILABLE"
      )
    },
    prepareImages(snapshot) {
      return prepareAdvertisingImages(snapshot, storage)
    },
    digest: defaultAdvertisingSyncDigest,
    async apply(runId, snapshot, digest, durationMs) {
      const result = await targetRpc("apply_advertising_roadmap_snapshot", {
        run_id: runId,
        snapshot,
        snapshot_digest: digest,
        duration_ms: durationMs,
      })
      if (!result || typeof result !== "object") {
        throw Object.assign(new Error("target apply response invalid"), {
          code: "TARGET_APPLY_FAILED",
        })
      }
      return result as { applied: boolean; cleanupPaths?: string[] }
    },
    async confirmApply(runId, digest) {
      const response = await fetchImpl(
        `${config.targetUrl}/rest/v1/roadmap_advertising_sync_state?select=active_run_id,last_snapshot_digest&singleton=eq.true`,
        { headers: serverHeaders(config.targetServiceRoleKey) }
      )
      const value = await readJsonResponse(response, "TARGET_APPLY_FAILED")
      const row = Array.isArray(value) ? value[0] : null
      if (row?.last_snapshot_digest === digest) return "committed"
      if (row?.active_run_id === runId) return "not_committed"
      return "unknown"
    },
    async fail(runId, code, message, durationMs) {
      await targetRpc("fail_advertising_roadmap_sync", {
        run_id: runId,
        error_code: code,
        error_message: message,
        duration_ms: durationMs,
      })
    },
    async cleanupQueuedObjects(paths) {
      const queued = paths ?? (await listCleanupPaths())
      let failed = 0
      for (const path of queued) {
        try {
          await storage.removeTarget([path])
          await targetRpc("confirm_advertising_object_cleanup", {
            paths: [path],
          })
        } catch {
          failed += 1
          try {
            await targetRpc("record_advertising_object_cleanup_failure", {
              path,
              error_code: "IMAGE_CLEANUP_FAILED",
            })
          } catch {
            // The queue row remains available for the next scheduled run.
          }
        }
      }
      return { attempted: queued.length, failed }
    },
    compensate(paths) {
      return compensateUploadedImages(paths, storage)
    },
    now: () => Date.now(),
    randomUuid: () => crypto.randomUUID(),
    logger: (entry) => console.log(JSON.stringify(entry)),
  }
}

type HandlerOptions = {
  getEnv?: GetEnv
  fetchImpl?: typeof fetch
  run?: () => Promise<Record<string, unknown>>
}

function responseStatus(code: string): number {
  if (code === "UNAUTHORIZED") return 401
  if (code === "SYNC_BUSY") return 409
  if (["SNAPSHOT_INVALID", "SOURCE_IDENTITY_INVALID"].includes(code)) return 422
  if (
    ["SOURCE_UNAVAILABLE", "IMAGE_UNAVAILABLE", "IMAGE_CONFLICT"].includes(code)
  ) {
    return 502
  }
  return 500
}

export function createAdvertisingSyncHandler(options: HandlerOptions = {}) {
  const getEnv = options.getEnv ?? getRuntimeEnv
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json(
        { ok: false, message: "仅支持 POST 请求" },
        { status: 405 }
      )
    }

    const providedCronSecret = request.headers.get("x-roadmap-sync-secret")
    if (!providedCronSecret) {
      const safe = safeSyncError({ code: "UNAUTHORIZED" })
      return Response.json({ ok: false, ...safe }, { status: 401 })
    }
    const expectedCronSecret = getEnv("ADVERTISING_SYNC_CRON_SECRET")
    if (!expectedCronSecret || expectedCronSecret.length < 32) {
      const safe = safeSyncError(runtimeConfigError())
      return Response.json({ ok: false, ...safe }, { status: 500 })
    }
    if (!(await hasValidSyncSecret(providedCronSecret, expectedCronSecret))) {
      const safe = safeSyncError({ code: "UNAUTHORIZED" })
      return Response.json({ ok: false, ...safe }, { status: 401 })
    }

    let config: AdvertisingSyncRuntimeConfig
    try {
      config = readAdvertisingSyncRuntimeConfig(getEnv)
    } catch (error) {
      const safe = safeSyncError(error)
      return Response.json({ ok: false, ...safe }, { status: 500 })
    }

    try {
      const result = options.run
        ? await options.run()
        : await runAdvertisingSync(
            createRuntimeDependencies(config, options.fetchImpl)
          )
      const digest =
        typeof result.digest === "string"
          ? result.digest.slice(0, 12)
          : undefined
      return Response.json(
        { ...result, ...(digest ? { digest } : {}) },
        { status: 200 }
      )
    } catch (error) {
      const safe = safeSyncError(error)
      return Response.json(
        { ok: false, ...safe },
        { status: responseStatus(safe.code) }
      )
    }
  }
}

const handler = createAdvertisingSyncHandler()

type DenoServeGlobal = typeof globalThis & {
  Deno?: {
    serve?: (handler: (request: Request) => Promise<Response>) => unknown
  }
}

const runtimeGlobal = globalThis as DenoServeGlobal
if (runtimeGlobal.Deno?.serve) runtimeGlobal.Deno.serve(handler)

const edgeFunction = { fetch: handler }
export default edgeFunction
