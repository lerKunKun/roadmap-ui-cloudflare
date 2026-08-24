import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AdminLogin } from "@/components/admin/admin-login"

describe("AdminLogin", () => {
  it("只显示管理密码，不暴露邮箱输入框", () => {
    render(<AdminLogin onSubmit={vi.fn()} pending={false} error={null} />)

    expect(screen.getByLabelText("管理密码")).toHaveAttribute(
      "type",
      "password",
    )
    expect(screen.queryByLabelText(/邮箱/)).not.toBeInTheDocument()
  })

  it("提交密码并保留失败后的输入值", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error("密码不正确"))

    render(
      <AdminLogin onSubmit={onSubmit} pending={false} error="密码不正确" />,
    )

    const password = screen.getByLabelText("管理密码")
    await user.type(password, "A-strong-test-password")
    await user.click(screen.getByRole("button", { name: "进入管理端" }))

    expect(onSubmit).toHaveBeenCalledWith("A-strong-test-password")
    expect(password).toHaveValue("A-strong-test-password")
    expect(screen.getByRole("alert")).toHaveTextContent("密码不正确")
  })
})
