import type { ValidatedSuggestionImage } from "./suggestion-image.ts"
import type { NormalizedSuggestion } from "./validation.ts"

export type { NormalizedSuggestion } from "./validation.ts"

export interface ImageMetadataInput {
  imageId: string
  itemId: string
  storagePath: string
  mimeType: "image/jpeg" | "image/png"
  sizeBytes: number
  width: number
  height: number
}

export interface SuggestionImageRepository {
  createItem(input: NormalizedSuggestion): Promise<string>
  consumeImageQuota(ipHash: string): Promise<boolean>
  createImageMetadata(input: ImageMetadataInput): Promise<void>
  uploadImage(path: string, bytes: Uint8Array, mimeType: string): Promise<void>
  removeImage(path: string): Promise<void>
  removeItem(itemId: string): Promise<void>
}

export type SuggestionSubmissionErrorCode =
  "image_rate" | "image_capacity" | "image_upload"

export class SuggestionSubmissionError extends Error {
  constructor(
    public readonly code: SuggestionSubmissionErrorCode,
    message: string
  ) {
    super(message)
    this.name = "SuggestionSubmissionError"
  }
}

export interface SubmitSuggestionInput {
  suggestion: NormalizedSuggestion
  image: ValidatedSuggestionImage | null
  imageIpHash: string | null
}

function errorContains(error: unknown, expected: string): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as Record<string, unknown>
  return [
    candidate.message,
    candidate.details,
    candidate.hint,
    candidate.code,
  ].some((value) => typeof value === "string" && value.includes(expected))
}

function publicImageFailure(error: unknown): SuggestionSubmissionError {
  if (errorContains(error, "roadmap_image_storage_full")) {
    return new SuggestionSubmissionError(
      "image_capacity",
      "图片存储空间已满，可移除图片后继续提交文字建议"
    )
  }
  return new SuggestionSubmissionError(
    "image_upload",
    "建议图片上传失败，请稍后重试"
  )
}

export async function submitSuggestionWithOptionalImage(
  input: SubmitSuggestionInput,
  repository: SuggestionImageRepository
): Promise<string> {
  const { suggestion, image, imageIpHash } = input
  if (!image) return repository.createItem(suggestion)

  if (!imageIpHash) {
    throw new SuggestionSubmissionError(
      "image_upload",
      "建议图片上传失败，请稍后重试"
    )
  }

  let quotaAvailable: boolean
  try {
    quotaAvailable = await repository.consumeImageQuota(imageIpHash)
  } catch {
    throw new SuggestionSubmissionError(
      "image_upload",
      "建议图片上传失败，请稍后重试"
    )
  }
  if (!quotaAvailable) {
    throw new SuggestionSubmissionError(
      "image_rate",
      "当前网络过去 24 小时图片提交次数已达上限"
    )
  }

  const itemId = await repository.createItem(suggestion)
  const imageId = crypto.randomUUID()
  const storagePath = `suggestions/${itemId}/${imageId}.${image.extension}`
  let uploadAttempted = false

  try {
    await repository.createImageMetadata({
      imageId,
      itemId,
      storagePath,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      width: image.width,
      height: image.height,
    })
    uploadAttempted = true
    await repository.uploadImage(storagePath, image.bytes, image.mimeType)
    return itemId
  } catch (error) {
    const publicFailure = publicImageFailure(error)
    const cleanup: Promise<unknown>[] = []
    if (uploadAttempted) {
      cleanup.push(
        Promise.resolve().then(() => repository.removeImage(storagePath))
      )
    }
    cleanup.push(Promise.resolve().then(() => repository.removeItem(itemId)))
    await Promise.allSettled(cleanup)
    throw publicFailure
  }
}
