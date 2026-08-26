import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SuggestionImageField } from "@/components/roadmap/suggestion-image-field"
import { validateSelectedSuggestionImage } from "@/features/roadmap/suggestion-image"

const createObjectURL = vi.fn<(file: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()

function imageFile(name = "proof.png", type = "image/png", size = 2_048) {
  return new File([new Uint8Array(size)], name, { type })
}

function ControlledImageField({ disabled = false }: { disabled?: boolean }) {
  const [image, setImage] = useState<File | null>(null)
  return (
    <SuggestionImageField
      value={image}
      onChange={setImage}
      disabled={disabled}
    />
  )
}

beforeEach(() => {
  createObjectURL.mockReset()
  revokeObjectURL.mockReset()
  createObjectURL
    .mockReturnValueOnce("blob:proof-one")
    .mockReturnValueOnce("blob:proof-two")
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  })
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({
      width: 640,
      height: 480,
      close: vi.fn(),
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("validateSelectedSuggestionImage", () => {
  it.each([
    ["proof.jpg", "image/jpeg"],
    ["proof.jpeg", "image/jpeg"],
    ["proof.png", "image/png"],
  ])("accepts a valid %s file", async (name, type) => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile(name, type),
        vi.fn().mockResolvedValue({ width: 800, height: 500 })
      )
    ).resolves.toBeUndefined()
  })

  it("rejects an empty image", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile("proof.png", "image/png", 0),
        vi.fn()
      )
    ).rejects.toThrow("图片不能为空")
  })

  it("rejects an image at the exact 5,000,000-byte limit", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile("proof.png", "image/png", 5_000_000),
        vi.fn()
      )
    ).rejects.toThrow("图片必须严格小于 5MB")
  })

  it("rejects a disallowed filename extension", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile("proof.gif", "image/png"),
        vi.fn()
      )
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects a MIME type that does not match the extension", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile("proof.jpg", "image/png"),
        vi.fn()
      )
    ).rejects.toThrow("图片格式不受支持或与文件内容不一致")
  })

  it("rejects an unreadable image dimension", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile(),
        vi.fn().mockRejectedValue(new Error("decode failed"))
      )
    ).rejects.toThrow("无法读取图片尺寸")
  })

  it("rejects an image with a 12,001-pixel edge", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile(),
        vi.fn().mockResolvedValue({ width: 12_001, height: 1 })
      )
    ).rejects.toThrow("图片宽高不能超过 12000 像素")
  })

  it("rejects an image above 40 megapixels", async () => {
    await expect(
      validateSelectedSuggestionImage(
        imageFile(),
        vi.fn().mockResolvedValue({ width: 8_001, height: 5_000 })
      )
    ).rejects.toThrow("图片像素不能超过 4000 万")
  })

  it("closes the default image bitmap after reading dimensions", async () => {
    const close = vi.fn()
    vi.mocked(createImageBitmap).mockResolvedValueOnce({
      width: 640,
      height: 480,
      close,
    } as ImageBitmap)

    await validateSelectedSuggestionImage(imageFile())

    expect(close).toHaveBeenCalledOnce()
  })
})

describe("SuggestionImageField", () => {
  it("shows the selected filename, formatted size, and preview", async () => {
    const user = userEvent.setup()
    render(<ControlledImageField />)

    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())

    expect(await screen.findByText("proof.png")).toBeInTheDocument()
    expect(screen.getByText("2 KB")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "所选图片预览" })).toHaveAttribute(
      "src",
      "blob:proof-one"
    )
  })

  it("removes the selected image and releases its object URL", async () => {
    const user = userEvent.setup()
    render(<ControlledImageField />)
    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())

    await user.click(await screen.findByRole("button", { name: "移除图片" }))

    expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:proof-one")
  })

  it("replaces the selected image and releases the previous object URL", async () => {
    const user = userEvent.setup()
    render(<ControlledImageField />)
    const input = screen.getByLabelText("附加图片（可选）")

    await user.upload(input, imageFile("first.png"))
    expect(await screen.findByText("first.png")).toBeInTheDocument()
    await user.upload(input, imageFile("second.jpg", "image/jpeg"))

    expect(await screen.findByText("second.jpg")).toBeInTheDocument()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:proof-one")
    expect(screen.getByRole("img", { name: "所选图片预览" })).toHaveAttribute(
      "src",
      "blob:proof-two"
    )
  })

  it("reports multiple selected files without changing the image", async () => {
    render(<ControlledImageField />)

    fireEvent.change(screen.getByLabelText("附加图片（可选）"), {
      target: { files: [imageFile("one.png"), imageFile("two.png")] },
    })

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "每条建议只能上传一张图片"
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it("shows validation failures in an alert", async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<ControlledImageField />)

    await user.upload(
      screen.getByLabelText("附加图片（可选）"),
      imageFile("proof.gif", "image/gif")
    )

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "图片格式不受支持或与文件内容不一致"
    )
  })

  it("releases the selected image object URL on unmount", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ControlledImageField />)
    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())
    await screen.findByText("proof.png")

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:proof-one")
  })

  it("disables file selection when its parent is pending", () => {
    render(<ControlledImageField disabled />)

    expect(screen.getByLabelText("附加图片（可选）")).toBeDisabled()
    expect(screen.getByRole("button", { name: "选择图片" })).toBeDisabled()
  })
})
