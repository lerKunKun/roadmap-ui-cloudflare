const MAX_IMAGE_SIZE_BYTES = 5_000_000
const MAX_IMAGE_EDGE = 12_000
const MAX_IMAGE_PIXELS = 40_000_000

export type ReadImageDimensions = (
  file: File
) => Promise<{ width: number; height: number }>

async function readImageDimensions(file: File) {
  let bitmap: ImageBitmap | null = null

  try {
    bitmap = await createImageBitmap(file)
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap?.close()
  }
}

export async function validateSelectedSuggestionImage(
  file: File,
  readDimensions: ReadImageDimensions = readImageDimensions
): Promise<void> {
  if (file.size === 0) {
    throw new Error("图片不能为空")
  }
  if (file.size >= MAX_IMAGE_SIZE_BYTES) {
    throw new Error("图片必须严格小于 5MB")
  }

  const filename = file.name.toLowerCase()
  const extension = filename.includes(".") ? filename.split(".").at(-1) : ""
  const mimeType = file.type.toLowerCase()
  const isJpeg =
    (extension === "jpg" || extension === "jpeg") && mimeType === "image/jpeg"
  const isPng = extension === "png" && mimeType === "image/png"

  if (!isJpeg && !isPng) {
    throw new Error("图片格式不受支持或与文件内容不一致")
  }

  let dimensions: { width: number; height: number }
  try {
    dimensions = await readDimensions(file)
  } catch {
    throw new Error("无法读取图片尺寸")
  }

  const { width, height } = dimensions
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("无法读取图片尺寸")
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new Error("图片宽高不能超过 12000 像素")
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error("图片像素不能超过 4000 万")
  }
}
