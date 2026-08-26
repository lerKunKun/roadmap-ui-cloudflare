import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SuggestionDialog } from "@/components/roadmap/suggestion-dialog"
import type { Project } from "@/features/roadmap/types"

const projects: Project[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "广告系统",
    slug: "advertising-system",
    projectUrl: "https://ads.example.test",
    sortOrder: 0,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "ks-alert",
    slug: "ks-alert",
    projectUrl: "https://alert.example.test",
    sortOrder: 1,
  },
]

const createObjectURL = vi.fn<(file: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()

function imageFile(name = "proof.png") {
  return new File([new Uint8Array(2_048)], name, { type: "image/png" })
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function deferredValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  createObjectURL.mockReset()
  revokeObjectURL.mockReset()
  createObjectURL.mockReturnValue("blob:proof")
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

describe("SuggestionDialog", () => {
  it("submits trimmed public fields with no image and resets after success", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.selectOptions(screen.getByLabelText("所属项目"), projects[1].id)
    await user.type(screen.getByLabelText("建议标题"), "  增加通知  ")
    await user.type(screen.getByLabelText("详细说明"), "  支持邮件通知  ")
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(onSubmit).toHaveBeenCalledWith({
      projectId: projects[1].id,
      title: "增加通知",
      description: "支持邮件通知",
      image: null,
    })

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.getByLabelText("建议标题")).toHaveValue("")
    expect(screen.getByLabelText("详细说明")).toHaveValue("")
  })

  it("submits the selected image file", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const image = imageFile()
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.upload(screen.getByLabelText("附加图片（可选）"), image)
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ image }))
  })

  it("disables every form control and displays the upload state while pending", async () => {
    const user = userEvent.setup()
    const request = deferred()
    const onSubmit = vi.fn().mockReturnValue(request.promise)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(
      await screen.findByRole("button", { name: "正在上传…" })
    ).toBeDisabled()
    expect(screen.getByLabelText("所属项目")).toBeDisabled()
    expect(screen.getByLabelText("建议标题")).toBeDisabled()
    expect(screen.getByLabelText("详细说明")).toBeDisabled()
    expect(screen.getByLabelText("附加图片（可选）")).toBeDisabled()
    expect(screen.getByRole("button", { name: "更换图片" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "移除图片" })).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: "关闭" })
    ).not.toBeInTheDocument()

    await act(async () => request.resolve())
  })

  it("keeps an in-flight image outside the submitted and reset form", async () => {
    const user = userEvent.setup()
    const validation = deferredValue<ImageBitmap>()
    vi.mocked(createImageBitmap).mockReturnValueOnce(validation.promise)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    const submitButton = screen.getByRole("button", { name: "确认提交" })
    const form = submitButton.closest("form")
    expect(form).not.toBeNull()

    fireEvent.change(screen.getByLabelText("附加图片（可选）"), {
      target: { files: [imageFile()] },
    })

    expect(submitButton).toBeDisabled()
    fireEvent.submit(form as HTMLFormElement)
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "关闭" }))
    await act(async () =>
      validation.resolve({
        width: 640,
        height: 480,
        close: vi.fn(),
      } as ImageBitmap)
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "确认提交" })).toBeEnabled()
  })

  it("submits text only after removing an image during replacement validation", async () => {
    const user = userEvent.setup()
    const replacementValidation = deferredValue<ImageBitmap>()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.upload(
      screen.getByLabelText("附加图片（可选）"),
      imageFile("first.png")
    )
    await screen.findByText("first.png")
    vi.mocked(createImageBitmap).mockReturnValueOnce(
      replacementValidation.promise
    )

    const fileInput = screen.getByLabelText("附加图片（可选）")
    const removeButton = screen.getByRole("button", { name: "移除图片" })
    act(() => {
      fireEvent.change(fileInput, {
        target: { files: [imageFile("replacement.png")] },
      })
      fireEvent.click(removeButton)
    })

    const submitButton = screen.getByRole("button", { name: "确认提交" })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ image: null })
    )

    await act(async () =>
      replacementValidation.resolve({
        width: 640,
        height: 480,
        close: vi.fn(),
      } as ImageBitmap)
    )
    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.queryByText("first.png")).not.toBeInTheDocument()
    expect(screen.queryByText("replacement.png")).not.toBeInTheDocument()
  })

  it("submits only once when two submit events arrive before rerender", async () => {
    const user = userEvent.setup()
    const request = deferred()
    const onSubmit = vi.fn().mockReturnValue(request.promise)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    const form = screen
      .getByRole("button", { name: "确认提交" })
      .closest("form")
    expect(form).not.toBeNull()

    act(() => {
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.submit(form as HTMLFormElement)
    })

    expect(onSubmit).toHaveBeenCalledOnce()
    await act(async () => request.resolve())
  })

  it("keeps the image URL until success, then clears and releases it", async () => {
    const user = userEvent.setup()
    const request = deferred()
    const onSubmit = vi.fn().mockReturnValue(request.promise)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())
    await screen.findByText("proof.png")
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(screen.getByText("proof.png")).toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await act(async () => request.resolve())
    await waitFor(() =>
      expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
    )
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:proof")

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
  })

  it("keeps all entered content and the image URL when submission fails", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error("网络暂时不可用"))
    const image = imageFile()
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.selectOptions(screen.getByLabelText("所属项目"), projects[1].id)
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.type(screen.getByLabelText("详细说明"), "保留这段内容")
    await user.upload(screen.getByLabelText("附加图片（可选）"), image)
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(await screen.findByText("网络暂时不可用")).toBeInTheDocument()
    expect(screen.getByLabelText("所属项目")).toHaveValue(projects[1].id)
    expect(screen.getByLabelText("建议标题")).toHaveValue("增加通知")
    expect(screen.getByLabelText("详细说明")).toHaveValue("保留这段内容")
    expect(screen.getByText("proof.png")).toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it("resets the form and releases the image URL when closed", async () => {
    const user = userEvent.setup()
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.upload(screen.getByLabelText("附加图片（可选）"), imageFile())
    await screen.findByText("proof.png")
    await user.click(screen.getByRole("button", { name: "关闭" }))

    await waitFor(() =>
      expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
    )
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:proof")

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.getByLabelText("建议标题")).toHaveValue("")
    expect(screen.queryByText("proof.png")).not.toBeInTheDocument()
  })
})
