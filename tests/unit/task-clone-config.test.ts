import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  assertTaskIdentity,
  generateTargetSecrets,
  parseTaskInputs,
  validateTaskIdentity,
  writeTargetInputsAtomic,
} from "../../scripts/task-clone/config.mjs"
import { runCaptured } from "../../scripts/task-clone/command.mjs"

const sourceInputs = {
  SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"s".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
  SUPABASE_DB_PASSWORD: "Source-db-password-2026!LongAndSecure",
  ADMIN_PASSWORD: "Source-admin-password-2026!LongAndSafe",
  VOTE_IP_SALT: "a".repeat(64),
}

const targetInputs = {
  ROADMAP_DOMAIN: "task.telljax.com",
  CLOUDFLARE_PAGES_PROJECT: "task-roadmap-ui",
  SUPABASE_PROJECT_REF: "bcdefghijklmnopqrstu",
  SUPABASE_URL: "https://bcdefghijklmnopqrstu.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"b".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"c".repeat(32)}`,
  SUPABASE_DB_PASSWORD: "Task-db-password-2026!LongAndSecure",
  ADMIN_EMAIL: "roadmap-admin@internal.invalid",
  ADMIN_PASSWORD: "Task-admin-password-2026!LongAndSafe",
  VOTE_IP_SALT: "d".repeat(64),
}

describe("task clone configuration", () => {
  it("accepts only the fixed target identity and an independent project", () => {
    expect(validateTaskIdentity(sourceInputs, targetInputs)).toEqual([])

    const errors = validateTaskIdentity(sourceInputs, {
      ...targetInputs,
      ROADMAP_DOMAIN: "telljax.com",
      CLOUDFLARE_PAGES_PROJECT: "roadmap-ui",
      SUPABASE_PROJECT_REF: sourceInputs.SUPABASE_PROJECT_REF,
      SUPABASE_URL: `https://${sourceInputs.SUPABASE_PROJECT_REF}.supabase.co`,
      VOTE_IP_SALT: sourceInputs.VOTE_IP_SALT,
    })

    expect(errors).toEqual([
      "ROADMAP_DOMAIN：必须是 task.telljax.com",
      "CLOUDFLARE_PAGES_PROJECT：必须是 task-roadmap-ui",
      "SUPABASE_PROJECT_REF：必须与源项目不同",
      "VOTE_IP_SALT：必须与源实例不同",
    ])
    expect(errors.join(" ")).not.toContain(targetInputs.SUPABASE_SECRET_KEY)
  })

  it("throws before a stage can use the source project as the target", () => {
    expect(() =>
      assertTaskIdentity(sourceInputs, {
        ...targetInputs,
        SUPABASE_PROJECT_REF: sourceInputs.SUPABASE_PROJECT_REF,
        SUPABASE_URL: `https://${sourceInputs.SUPABASE_PROJECT_REF}.supabase.co`,
      }),
    ).toThrow("目标部署配置无效")
  })

  it.each([
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_DB_PASSWORD",
    "ADMIN_PASSWORD",
  ])("rejects reuse of source credential %s", (field) => {
    expect(
      validateTaskIdentity(sourceInputs, {
        ...targetInputs,
        [field]: sourceInputs[field as keyof typeof sourceInputs],
      }),
    ).toContain(`${field}：必须与源实例不同`)
  })

  it("generates strong target-only passwords and a hexadecimal salt", () => {
    let fill = 1
    const secrets = generateTargetSecrets((size: number) =>
      Buffer.alloc(size, fill++),
    )

    for (const password of [secrets.databasePassword, secrets.adminPassword]) {
      expect(password.length).toBeGreaterThanOrEqual(32)
      expect(password).toMatch(/[A-Z]/)
      expect(password).toMatch(/[a-z]/)
      expect(password).toMatch(/\d/)
      expect(password).toMatch(/[^A-Za-z0-9]/)
    }
    expect(secrets.databasePassword).not.toBe(secrets.adminPassword)
    expect(secrets.voteIpSalt).toMatch(/^[a-f0-9]{64}$/)
  })

  it("writes quoted values atomically and parses symbols literally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-roadmap-config-"))
    const path = join(directory, ".env.task.deploy.local")
    const inputs = {
      ...targetInputs,
      ADMIN_PASSWORD: "Aa1!$value#with=separators-and-32-chars",
    }

    await writeTargetInputsAtomic(path, inputs)

    expect(parseTaskInputs(await readFile(path, "utf8"))).toEqual(inputs)
  })

  it("refuses to overwrite a target file for another project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-roadmap-config-"))
    const path = join(directory, ".env.task.deploy.local")
    await writeFile(
      path,
      'SUPABASE_PROJECT_REF="anotherprojectrefxxx"\n',
      "utf8",
    )

    await expect(
      writeTargetInputsAtomic(path, targetInputs, {
        expectedProjectRef: targetInputs.SUPABASE_PROJECT_REF,
      }),
    ).rejects.toThrow("目标配置属于其他 Supabase 项目")

    expect(await readFile(path, "utf8")).toBe(
      'SUPABASE_PROJECT_REF="anotherprojectrefxxx"\n',
    )
  })

  it("redacts child output when a command fails", async () => {
    const leaked = "sb_secret_should-never-appear"

    await expect(
      runCaptured(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(leaked)}); process.exit(7)`],
        { operation: "测试安全命令" },
      ),
    ).rejects.toMatchObject({
      message: "测试安全命令失败（退出码 7）",
    })

    try {
      await runCaptured(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(leaked)}); process.exit(7)`],
        { operation: "测试安全命令" },
      )
    } catch (error) {
      expect(String(error)).not.toContain(leaked)
    }
  })
})
