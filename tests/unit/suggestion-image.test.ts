import { describe, expect, it } from "vitest"

import {
  parseSuggestionRequest,
  validateSuggestionImage,
} from "../../supabase/functions/_shared/suggestion-image"

const projectId = "11111111-1111-4111-8111-111111111111"

function setUint32(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint32(offset, value)
}

function validPngBytes(width: number, height: number) {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  setUint32(bytes, 8, 13)
  bytes.set([73, 72, 68, 82], 12)
  setUint32(bytes, 16, width)
  setUint32(bytes, 20, height)
  bytes.set([8, 2, 0, 0, 0], 24)
  return bytes
}

function validPngFile(
  width: number,
  height: number,
  options: { name?: string; type?: string } = {}
) {
  const bytes = validPngBytes(width, height)
  return new File([bytes], options.name ?? "proof.png", {
    type: options.type ?? "image/png",
  })
}

function requestWithFormData(formData: FormData): Request {
  return {
    headers: new Headers({
      "Content-Type": "multipart/form-data; boundary=test-boundary",
    }),
    formData: async () => formData,
  } as Request
}

function validJpegFile(
  width: number,
  height: number,
  options: { name?: string; type?: string } = {}
) {
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ])
  return new File([bytes], options.name ?? "proof.jpg", {
    type: options.type ?? "image/jpeg",
  })
}

describe("validateSuggestionImage", () => {
  it("reads PNG dimensions from the IHDR chunk", async () => {
    await expect(
      validateSuggestionImage(validPngFile(640, 480))
    ).resolves.toMatchObject({
      extension: "png",
      mimeType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 33,
    })
  })

  it.each(["proof.jpg", "proof.jpeg"])(
    "reads JPEG SOF dimensions and normalizes %s to jpg",
    async (name) => {
      await expect(
        validateSuggestionImage(validJpegFile(1920, 1080, { name }))
      ).resolves.toMatchObject({
        extension: "jpg",
        mimeType: "image/jpeg",
        width: 1920,
        height: 1080,
      })
    }
  )

  it("rejects a file exactly at the byte limit", async () => {
    await expect(
      validateSuggestionImage(
        new File([new Uint8Array(5_000_000)], "proof.png", {
          type: "image/png",
        })
      )
    ).rejects.toThrow("图片必须严格小于 5MB")
  })

  it("rejects an empty file", async () => {
    await expect(
      validateSuggestionImage(new File([], "proof.png", { type: "image/png" }))
    ).rejects.toThrow("图片不能为空")
  })

  it("rejects a filename extension that disagrees with the MIME type", async () => {
    await expect(
      validateSuggestionImage(validPngFile(640, 480, { name: "proof.jpg" }))
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects a browser MIME type that disagrees with the filename", async () => {
    await expect(
      validateSuggestionImage(validPngFile(640, 480, { type: "image/jpeg" }))
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects a forged PNG signature", async () => {
    await expect(
      validateSuggestionImage(
        new File([new Uint8Array(33)], "proof.png", { type: "image/png" })
      )
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects a JPEG without a supported SOF marker", async () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
    ])
    await expect(
      validateSuggestionImage(
        new File([bytes], "proof.jpg", { type: "image/jpeg" })
      )
    ).rejects.toThrow("无法读取图片尺寸")
  })

  it("rejects a JPEG with a truncated segment length", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x20, 0x00])
    await expect(
      validateSuggestionImage(
        new File([bytes], "proof.jpg", { type: "image/jpeg" })
      )
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects an image with a 12,001-pixel edge", async () => {
    await expect(
      validateSuggestionImage(validPngFile(12_001, 1))
    ).rejects.toThrow("图片宽高不能超过 12000 像素")
  })

  it("rejects an image above 40 megapixels", async () => {
    await expect(
      validateSuggestionImage(validPngFile(8_000, 5_001))
    ).rejects.toThrow("图片像素不能超过 4000 万")
  })
})

describe("parseSuggestionRequest", () => {
  it("keeps the legacy JSON request and returns no image", async () => {
    const request = new Request("https://example.test/submit-suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        projectId,
        title: "  增加导出功能  ",
        description: "  支持 CSV  ",
      }),
    })

    await expect(parseSuggestionRequest(request)).resolves.toEqual({
      projectId,
      title: "增加导出功能",
      description: "支持 CSV",
      image: null,
    })
  })

  it("parses multipart text fields and one image", async () => {
    const formData = new FormData()
    formData.set("projectId", projectId)
    formData.set("title", "  截图建议  ")
    formData.set("description", "  复现步骤  ")
    formData.set("image", validPngFile(640, 480))

    const parsed = await parseSuggestionRequest(requestWithFormData(formData))

    expect(parsed).toMatchObject({
      projectId,
      title: "截图建议",
      description: "复现步骤",
    })
    expect(Object.prototype.toString.call(parsed.image)).toBe("[object File]")
    expect(parsed.image?.name).toBe("proof.png")
  })

  it("accepts a multipart text-only request", async () => {
    const formData = new FormData()
    formData.set("projectId", projectId)
    formData.set("title", "纯文字建议")
    formData.set("description", "无需附图")

    await expect(
      parseSuggestionRequest(requestWithFormData(formData))
    ).resolves.toMatchObject({ image: null })
  })

  it("rejects unsupported request media types", async () => {
    await expect(
      parseSuggestionRequest(
        new Request("https://example.test/submit-suggestion", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "not supported",
        })
      )
    ).rejects.toThrow("请求格式不受支持")
  })

  it("rejects repeated image fields", async () => {
    const formData = new FormData()
    formData.set("projectId", projectId)
    formData.set("title", "重复图片")
    formData.set("description", "")
    formData.append("image", validPngFile(2, 2, { name: "one.png" }))
    formData.append("image", validPngFile(2, 2, { name: "two.png" }))

    await expect(
      parseSuggestionRequest(requestWithFormData(formData))
    ).rejects.toThrow("每条建议只能上传一张图片")
  })

  it("rejects unknown file fields", async () => {
    const formData = new FormData()
    formData.set("projectId", projectId)
    formData.set("title", "未知附件")
    formData.set("description", "")
    formData.set("attachment", validPngFile(2, 2))

    await expect(
      parseSuggestionRequest(requestWithFormData(formData))
    ).rejects.toThrow("请求包含不支持的文件字段")
  })
})
