const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/

export type SyncErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "SOURCE_IDENTITY_INVALID"
  | "SNAPSHOT_INVALID"
  | "SOURCE_UNAVAILABLE"
  | "IMAGE_CONFLICT"
  | "IMAGE_UNAVAILABLE"
  | "TARGET_APPLY_FAILED"
  | "SYNC_BUSY"
  | "INTERNAL_ERROR"

const SAFE_MESSAGES: Record<SyncErrorCode, string> = {
  UNAUTHORIZED: "同步请求认证失败",
  INVALID_REQUEST: "同步请求格式无效",
  SOURCE_IDENTITY_INVALID: "源 Supabase 身份无效",
  SNAPSHOT_INVALID: "源广告系统快照无效",
  SOURCE_UNAVAILABLE: "暂时无法读取源广告系统",
  IMAGE_CONFLICT: "目标图片路径存在内容冲突",
  IMAGE_UNAVAILABLE: "暂时无法同步广告系统图片",
  TARGET_APPLY_FAILED: "目标广告系统替换失败",
  SYNC_BUSY: "广告系统同步正在运行",
  INTERNAL_ERROR: "同步失败，请查看安全日志代码",
}

export function assertSourceIdentity(url: string, projectRef: string): URL {
  try {
    if (!PROJECT_REF_PATTERN.test(projectRef)) throw new Error("invalid ref")
    const parsed = new URL(url)
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== `${projectRef}.supabase.co` ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("invalid origin")
    }
    return parsed
  } catch {
    throw Object.assign(new Error("源 Supabase 身份无效"), {
      code: "SOURCE_IDENTITY_INVALID",
    })
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  )
}

export async function hasValidSyncSecret(
  provided: string | null,
  expected: string
): Promise<boolean> {
  if (expected.length < 32) return false
  const [providedDigest, expectedDigest] = await Promise.all([
    sha256(provided ?? ""),
    sha256(expected),
  ])
  let difference = provided === null ? 1 : 0
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= providedDigest[index] ^ expectedDigest[index]
  }
  return difference === 0
}

export function safeSyncError(error: unknown): {
  code: SyncErrorCode
  message: string
} {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : ""
  const code =
    candidate in SAFE_MESSAGES ? (candidate as SyncErrorCode) : "INTERNAL_ERROR"
  return { code, message: SAFE_MESSAGES[code] }
}
