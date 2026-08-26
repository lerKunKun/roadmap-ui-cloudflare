// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Supabase Deno requires explicit TypeScript extensions.
import { parseSuggestionFields } from "./validation.ts"

const MAX_IMAGE_SIZE_BYTES = 5_000_000
const MAX_IMAGE_EDGE = 12_000
const MAX_IMAGE_PIXELS = 40_000_000
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

export interface ParsedSuggestionRequest {
  projectId: string
  title: string
  description: string
  image: File | null
}

export interface ValidatedSuggestionImage {
  bytes: Uint8Array
  extension: "jpg" | "png"
  mimeType: "image/jpeg" | "image/png"
  sizeBytes: number
  width: number
  height: number
}

function invalidSuggestionFields(): Error {
  return new Error("请检查项目、标题和详细说明")
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof File !== "undefined" && value instanceof File
}

function parseTextFields(values: unknown) {
  try {
    return parseSuggestionFields(values)
  } catch {
    throw invalidSuggestionFields()
  }
}

export async function parseSuggestionRequest(
  request: Request
): Promise<ParsedSuggestionRequest> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase()

  if (mediaType === "application/json") {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new Error("请求内容不是有效的 JSON")
    }

    return { ...parseTextFields(body), image: null }
  }

  if (mediaType !== "multipart/form-data") {
    throw new Error("请求格式不受支持")
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    throw new Error("请求内容不是有效的表单")
  }

  for (const [field, value] of formData.entries()) {
    if (isFile(value) && field !== "image") {
      throw new Error("请求包含不支持的文件字段")
    }
  }

  const projectIds = formData.getAll("projectId")
  const titles = formData.getAll("title")
  const descriptions = formData.getAll("description")
  if (
    projectIds.length !== 1 ||
    titles.length !== 1 ||
    descriptions.length !== 1 ||
    typeof projectIds[0] !== "string" ||
    typeof titles[0] !== "string" ||
    typeof descriptions[0] !== "string"
  ) {
    throw invalidSuggestionFields()
  }

  const images = formData.getAll("image")
  if (images.length > 1) {
    throw new Error("每条建议只能上传一张图片")
  }

  let image: File | null = null
  if (images.length === 1) {
    const candidate = images[0]
    if (!isFile(candidate)) {
      throw new Error("图片文件无效")
    }
    if (candidate.size === 0) {
      throw new Error("图片不能为空")
    }
    image = candidate
  }

  return {
    ...parseTextFields({
      projectId: projectIds[0],
      title: titles[0],
      description: descriptions[0],
    }),
    image,
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(offset)
}

function parsePngDimensions(bytes: Uint8Array) {
  if (bytes.length < 33) {
    throw new Error("图片格式不受支持或与文件内容不一致")
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }
  }

  const isIhdr =
    readUint32(bytes, 8) === 13 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52
  if (!isIhdr) {
    throw new Error("图片格式不受支持或与文件内容不一致")
  }

  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) }
}

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

function isSupportedSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  )
}

function parseJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("图片格式不受支持或与文件内容不一致")
  }

  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }

    const marker = bytes[offset]
    offset += 1
    if (marker === 0x00) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }
    if (marker === 0xd9 || marker === 0xda) break
    if (isStandaloneJpegMarker(marker)) continue

    if (offset + 2 > bytes.length) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1]
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new Error("图片格式不受支持或与文件内容不一致")
    }

    if (isSupportedSofMarker(marker)) {
      if (segmentLength < 7) {
        throw new Error("图片格式不受支持或与文件内容不一致")
      }
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      }
    }

    offset += segmentLength
  }

  throw new Error("无法读取图片尺寸")
}

export async function validateSuggestionImage(
  file: File
): Promise<ValidatedSuggestionImage> {
  if (file.size === 0) throw new Error("图片不能为空")
  if (file.size >= MAX_IMAGE_SIZE_BYTES) {
    throw new Error("图片必须严格小于 5MB")
  }

  const filename = file.name.toLowerCase()
  const rawExtension = filename.includes(".") ? filename.split(".").at(-1) : ""
  const mimeType = file.type.toLowerCase()
  let extension: "jpg" | "png"
  let normalizedMimeType: "image/jpeg" | "image/png"

  if (
    (rawExtension === "jpg" || rawExtension === "jpeg") &&
    mimeType === "image/jpeg"
  ) {
    extension = "jpg"
    normalizedMimeType = "image/jpeg"
  } else if (rawExtension === "png" && mimeType === "image/png") {
    extension = "png"
    normalizedMimeType = "image/png"
  } else {
    throw new Error("图片格式不受支持或与文件内容不一致")
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength !== file.size) {
    throw new Error("图片文件读取失败")
  }
  const { width, height } =
    extension === "png" ? parsePngDimensions(bytes) : parseJpegDimensions(bytes)

  if (width < 1 || height < 1) throw new Error("无法读取图片尺寸")
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new Error("图片宽高不能超过 12000 像素")
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error("图片像素不能超过 4000 万")
  }

  return {
    bytes,
    extension,
    mimeType: normalizedMimeType,
    sizeBytes: bytes.byteLength,
    width,
    height,
  }
}
