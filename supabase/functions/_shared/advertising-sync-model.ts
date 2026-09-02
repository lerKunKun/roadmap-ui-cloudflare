import { z } from "zod"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STORAGE_PATH_PATTERN =
  /^suggestions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png)$/
const BIGINT_MAX = BigInt("9223372036854775807")
const MAX_IMAGE_BYTES = 1_000_000_000
const FORBIDDEN_KEYS = new Set([
  "auth",
  "ip",
  "ip_hash",
  "password",
  "salt",
  "secret",
  "token",
  "votes",
])

const uuidSchema = z.string().regex(UUID_PATTERN)
const timestampSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)),
  "时间格式无效",
)
const orderSchema = z.number().int().safe().min(-2_147_483_648).max(2_147_483_647)
const decimalBigintSchema = z
  .string()
  .refine(
    (value) => /^\d+$/.test(value) && BigInt(value) <= BIGINT_MAX,
    "bigint 格式或范围无效",
  )
const statusSchema = z.enum([
  "pending",
  "approved",
  "in_progress",
  "completed",
  "rejected",
])

const projectSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(80),
    slug: z.literal("advertising-system"),
    projectUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:")
      .nullable(),
    sortOrder: orderSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()

const itemSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    title: z.string().trim().min(2).max(120),
    description: z.string().max(4000),
    status: statusSchema,
    sortOrder: orderSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    voteBaseline: decimalBigintSchema,
  })
  .strict()

const historySchema = z
  .object({
    sourceOrder: decimalBigintSchema,
    roadmapItemId: uuidSchema,
    fromStatus: statusSchema.nullable(),
    toStatus: statusSchema,
    changedAt: timestampSchema,
  })
  .strict()
  .refine((row) => row.fromStatus === null || row.fromStatus !== row.toStatus)

const imageFields = {
  id: uuidSchema,
  roadmapItemId: uuidSchema,
  storagePath: z.string().regex(STORAGE_PATH_PATTERN),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  sizeBytes: z.number().int().min(1).max(4_999_999),
  width: z.number().int().min(1).max(12_000),
  height: z.number().int().min(1).max(12_000),
  createdAt: timestampSchema,
} as const

const sourceImageSchema = z
  .object(imageFields)
  .strict()
  .refine((image) => image.width * image.height <= 40_000_000)
const hydratedImageSchema = z
  .object({ ...imageFields, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
  .refine((image) => image.width * image.height <= 40_000_000)

function addDuplicateIssues(
  rows: Array<Record<string, unknown>>,
  field: string,
  context: z.RefinementCtx,
) {
  const seen = new Set<unknown>()
  for (const row of rows) {
    const value = row[field]
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `${field} 重复` })
    }
    seen.add(value)
  }
}

function validateRelations(
  value: {
    project: z.infer<typeof projectSchema>
    items: Array<z.infer<typeof itemSchema>>
    histories: Array<z.infer<typeof historySchema>>
    images: Array<z.infer<typeof sourceImageSchema>>
  },
  context: z.RefinementCtx,
) {
  addDuplicateIssues(value.items, "id", context)
  addDuplicateIssues(value.histories, "sourceOrder", context)
  addDuplicateIssues(value.images, "id", context)
  addDuplicateIssues(value.images, "storagePath", context)
  addDuplicateIssues(value.images, "roadmapItemId", context)

  const itemIds = new Set(value.items.map((item) => item.id))
  for (const item of value.items) {
    if (item.projectId !== value.project.id) {
      context.addIssue({ code: "custom", message: "条目引用了其他项目" })
    }
  }
  for (const history of value.histories) {
    if (!itemIds.has(history.roadmapItemId)) {
      context.addIssue({ code: "custom", message: "时间轴引用了未知条目" })
    }
  }
  for (const image of value.images) {
    if (!itemIds.has(image.roadmapItemId)) {
      context.addIssue({ code: "custom", message: "图片引用了未知条目" })
    }
  }
  const totalImageBytes = value.images.reduce(
    (total, image) => total + image.sizeBytes,
    0,
  )
  if (totalImageBytes > MAX_IMAGE_BYTES) {
    context.addIssue({ code: "custom", message: "图片逻辑总量超过 1GB" })
  }
}

function createSnapshotSchema<TImage extends z.ZodTypeAny>(imageSchema: TImage) {
  return z
    .object({
      version: z.literal(1),
      capturedAt: timestampSchema,
      project: projectSchema,
      items: z.array(itemSchema).max(5_000),
      histories: z.array(historySchema).max(50_000),
      images: z.array(imageSchema).max(5_000),
    })
    .strict()
    .superRefine((value, context) =>
      validateRelations(
        value as Parameters<typeof validateRelations>[0],
        context,
      ),
    )
}

export const advertisingSnapshotSchema = createSnapshotSchema(sourceImageSchema)
export const hydratedAdvertisingSnapshotSchema = createSnapshotSchema(
  hydratedImageSchema,
)

export type AdvertisingSnapshot = z.infer<typeof advertisingSnapshotSchema>
export type HydratedAdvertisingSnapshot = z.infer<
  typeof hydratedAdvertisingSnapshotSchema
>

function findForbiddenKey(value: unknown, seen = new Set<unknown>()): string | null {
  if (value === null || typeof value !== "object" || seen.has(value)) return null
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return key
    const nested = findForbiddenKey(child, seen)
    if (nested) return nested
  }
  return null
}

function parseSnapshot<T>(schema: z.ZodType<T>, value: unknown): T {
  const forbidden = findForbiddenKey(value)
  if (forbidden) {
    throw Object.assign(new Error(`广告系统快照无效：包含禁止字段 ${forbidden}`), {
      code: "SNAPSHOT_INVALID",
    })
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    const message =
      result.error.issues.find((issue) => issue.message === "图片逻辑总量超过 1GB")
        ?.message ?? result.error.issues[0]?.message ?? "结构错误"
    throw Object.assign(new Error(`广告系统快照无效：${message}`), {
      code: "SNAPSHOT_INVALID",
    })
  }
  return structuredClone(result.data)
}

export function parseAdvertisingSnapshot(value: unknown): AdvertisingSnapshot {
  return parseSnapshot(advertisingSnapshotSchema, value)
}

export function parseHydratedAdvertisingSnapshot(
  value: unknown,
): HydratedAdvertisingSnapshot {
  return parseSnapshot(hydratedAdvertisingSnapshotSchema, value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export async function digestAdvertisingSnapshot(
  value: unknown,
): Promise<string> {
  const snapshot = parseHydratedAdvertisingSnapshot(value)
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(snapshot)))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
