import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

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

describe("SuggestionDialog", () => {
  it("submits trimmed public fields and resets after success", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />,
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
    })

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    expect(screen.getByLabelText("建议标题")).toHaveValue("")
    expect(screen.getByLabelText("详细说明")).toHaveValue("")
  })

  it("keeps entered content when submission fails", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error("网络暂时不可用"))
    render(
      <SuggestionDialog
        projects={projects}
        selectedProjectId={projects[0].id}
        onSubmit={onSubmit}
      />,
    )

    await user.click(screen.getByRole("button", { name: "提交建议" }))
    await user.type(screen.getByLabelText("建议标题"), "增加通知")
    await user.type(screen.getByLabelText("详细说明"), "保留这段内容")
    await user.click(screen.getByRole("button", { name: "确认提交" }))

    expect(await screen.findByText("网络暂时不可用")).toBeInTheDocument()
    expect(screen.getByLabelText("建议标题")).toHaveValue("增加通知")
    expect(screen.getByLabelText("详细说明")).toHaveValue("保留这段内容")
  })
})
