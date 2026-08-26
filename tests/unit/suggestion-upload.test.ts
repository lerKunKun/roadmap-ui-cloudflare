import { describe, expect, it } from "vitest"

import type { ValidatedSuggestionImage } from "../../supabase/functions/_shared/suggestion-image"
import {
  submitSuggestionWithOptionalImage,
  type ImageMetadataInput,
  type NormalizedSuggestion,
  type SuggestionImageRepository,
} from "../../supabase/functions/_shared/suggestion-upload"

const suggestion: NormalizedSuggestion = {
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "建议标题",
  description: "建议说明",
}

const jpegImage: ValidatedSuggestionImage = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  extension: "jpg",
  mimeType: "image/jpeg",
  sizeBytes: 4,
  width: 1,
  height: 1,
}

const pngImage: ValidatedSuggestionImage = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  extension: "png",
  mimeType: "image/png",
  sizeBytes: 4,
  width: 2,
  height: 2,
}

interface RepositoryOptions {
  quotaAvailable?: boolean
  metadataError?: Error
  uploadError?: Error
  removeImageError?: Error
  removeItemError?: Error
  expectedImage?: ValidatedSuggestionImage
}

function createRepository(options: RepositoryOptions = {}) {
  const events: string[] = []
  const metadata: ImageMetadataInput[] = []
  const uploadedPaths: string[] = []

  const repository: SuggestionImageRepository = {
    async createItem(input) {
      events.push("createItem")
      expect(input).toEqual(suggestion)
      return "22222222-2222-4222-8222-222222222222"
    },
    async consumeImageQuota(ipHash) {
      events.push(`consumeImageQuota:${ipHash}`)
      return options.quotaAvailable ?? true
    },
    async createImageMetadata(input) {
      events.push("createImageMetadata")
      metadata.push(input)
      if (options.metadataError) throw options.metadataError
    },
    async uploadImage(path, bytes, mimeType) {
      events.push("uploadImage")
      uploadedPaths.push(path)
      expect(bytes).toEqual((options.expectedImage ?? jpegImage).bytes)
      expect(mimeType).toBe((options.expectedImage ?? jpegImage).mimeType)
      if (options.uploadError) throw options.uploadError
    },
    async removeImage(path) {
      events.push(`removeImage:${path}`)
      if (options.removeImageError) throw options.removeImageError
    },
    async removeItem(itemId) {
      events.push(`removeItem:${itemId}`)
      if (options.removeItemError) throw options.removeItemError
    },
  }

  return { repository, events, metadata, uploadedPaths }
}

describe("submitSuggestionWithOptionalImage", () => {
  it("creates only the item for a pure-text suggestion", async () => {
    const { repository, events } = createRepository()

    await expect(
      submitSuggestionWithOptionalImage(
        { suggestion, image: null, imageIpHash: null },
        repository
      )
    ).resolves.toBe("22222222-2222-4222-8222-222222222222")
    expect(events).toEqual(["createItem"])
  })

  it("consumes image quota before creating an item", async () => {
    const { repository, events } = createRepository()

    await submitSuggestionWithOptionalImage(
      { suggestion, image: jpegImage, imageIpHash: "image-hash" },
      repository
    )

    expect(events.slice(0, 2)).toEqual([
      "consumeImageQuota:image-hash",
      "createItem",
    ])
  })

  it.each([
    { image: jpegImage, extension: "jpg" },
    { image: pngImage, extension: "png" },
  ])(
    "uses a server-generated .$extension path and creates metadata before upload",
    async ({ image, extension }) => {
      const { repository, events, metadata, uploadedPaths } = createRepository({
        expectedImage: image,
      })

      await submitSuggestionWithOptionalImage(
        { suggestion, image, imageIpHash: "image-hash" },
        repository
      )

      expect(events).toEqual([
        "consumeImageQuota:image-hash",
        "createItem",
        "createImageMetadata",
        "uploadImage",
      ])
      expect(metadata).toHaveLength(1)
      expect(metadata[0]).toMatchObject({
        itemId: "22222222-2222-4222-8222-222222222222",
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        width: image.width,
        height: image.height,
      })
      expect(metadata[0].imageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      expect(metadata[0].storagePath).toBe(
        `suggestions/22222222-2222-4222-8222-222222222222/${metadata[0].imageId}.${extension}`
      )
      expect(uploadedPaths).toEqual([metadata[0].storagePath])
      expect(metadata[0].storagePath).not.toContain("proof")
    }
  )

  it("returns the stable image quota error without creating an item", async () => {
    const { repository, events } = createRepository({ quotaAvailable: false })

    await expect(
      submitSuggestionWithOptionalImage(
        { suggestion, image: jpegImage, imageIpHash: "image-hash" },
        repository
      )
    ).rejects.toThrow("当前网络过去 24 小时图片提交次数已达上限")
    expect(events).toEqual(["consumeImageQuota:image-hash"])
  })

  it("maps capacity rejection and removes the created item", async () => {
    const { repository, events } = createRepository({
      metadataError: new Error("roadmap_image_storage_full"),
    })

    await expect(
      submitSuggestionWithOptionalImage(
        { suggestion, image: jpegImage, imageIpHash: "image-hash" },
        repository
      )
    ).rejects.toThrow("图片存储空间已满，可移除图片后继续提交文字建议")
    expect(events).toEqual([
      "consumeImageQuota:image-hash",
      "createItem",
      "createImageMetadata",
      "removeItem:22222222-2222-4222-8222-222222222222",
    ])
  })

  it("removes the item when metadata creation fails", async () => {
    const { repository, events } = createRepository({
      metadataError: new Error("database unavailable"),
    })

    await expect(
      submitSuggestionWithOptionalImage(
        { suggestion, image: jpegImage, imageIpHash: "image-hash" },
        repository
      )
    ).rejects.toThrow("建议图片上传失败，请稍后重试")
    expect(events.at(-1)).toBe(
      "removeItem:22222222-2222-4222-8222-222222222222"
    )
    expect(events.some((event) => event.startsWith("removeImage:"))).toBe(false)
  })

  it("attempts object removal and item removal after upload fails", async () => {
    const { repository, events, uploadedPaths } = createRepository({
      uploadError: new Error("storage unavailable"),
    })

    await expect(
      submitSuggestionWithOptionalImage(
        { suggestion, image: jpegImage, imageIpHash: "image-hash" },
        repository
      )
    ).rejects.toThrow("建议图片上传失败，请稍后重试")
    expect(events.slice(-2)).toEqual([
      `removeImage:${uploadedPaths[0]}`,
      "removeItem:22222222-2222-4222-8222-222222222222",
    ])
  })

  it("does not expose cleanup failures or replace the stable upload error", async () => {
    const { repository } = createRepository({
      uploadError: new Error("private storage path failed"),
      removeImageError: new Error("private object cleanup failed"),
      removeItemError: new Error("private database cleanup failed"),
    })

    const failure = submitSuggestionWithOptionalImage(
      { suggestion, image: jpegImage, imageIpHash: "image-hash" },
      repository
    )
    await expect(failure).rejects.toThrow("建议图片上传失败，请稍后重试")
    await expect(failure).rejects.not.toThrow("cleanup")
  })
})
