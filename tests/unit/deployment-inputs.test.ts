import { describe, expect, it } from "vitest"

import {
  parseDeploymentInputs,
  validateDeploymentInputs,
} from "../../scripts/deployment-inputs.mjs"

const validInputs = {
  ROADMAP_DOMAIN: "roadmap.example.com",
  ADVERTISING_SYSTEM_URL: "https://ads.example.com",
  KS_ALERT_URL: "https://alert.example.com",
  TEMPLATE_TOOLS_URL: "https://templates.example.com",
  SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
  SUPABASE_ACCESS_TOKEN: `sbp_${"c".repeat(40)}`,
  SUPABASE_DB_PASSWORD: "database-password-2026!",
  ADMIN_PASSWORD: "Admin-password-2026!Secure-Roadmap",
  VOTE_IP_SALT: "d".repeat(64),
  CLOUDFLARE_ACCOUNT_ID: "e".repeat(32),
  CLOUDFLARE_ZONE_ID: "f".repeat(32),
  CLOUDFLARE_API_TOKEN: "g".repeat(40),
  CLOUDFLARE_PAGES_PROJECT: "roadmap-ui",
}

describe("deployment inputs", () => {
  it("accepts a complete deployment configuration", () => {
    expect(validateDeploymentInputs(validInputs)).toEqual([])
  })

  it("reports every missing required field without including secret values", () => {
    const errors = validateDeploymentInputs({
      ...validInputs,
      ROADMAP_DOMAIN: "",
      SUPABASE_SECRET_KEY: "请填写",
      CLOUDFLARE_API_TOKEN: "",
    })

    expect(errors).toEqual([
      "ROADMAP_DOMAIN：未填写",
      "SUPABASE_SECRET_KEY：未填写",
      "CLOUDFLARE_API_TOKEN：未填写",
    ])
    expect(errors.join(" ")).not.toContain("sb_secret_")
  })

  it("rejects malformed domains, URLs, keys, passwords and salts", () => {
    const errors = validateDeploymentInputs({
      ...validInputs,
      ROADMAP_DOMAIN: "https://roadmap.example.com/path",
      KS_ALERT_URL: "javascript:alert(1)",
      SUPABASE_PROJECT_REF: "bad-ref",
      SUPABASE_URL: "https://another-project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "anon-key",
      SUPABASE_SECRET_KEY: "secret",
      SUPABASE_ACCESS_TOKEN: "token",
      SUPABASE_DB_PASSWORD: "short",
      ADMIN_PASSWORD: "Biou2026@",
      VOTE_IP_SALT: "not-random",
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_ZONE_ID: "zone",
      CLOUDFLARE_API_TOKEN: "tiny",
      CLOUDFLARE_PAGES_PROJECT: "Roadmap UI",
    })

    expect(errors).toEqual([
      "ROADMAP_DOMAIN：应只填写域名，不含协议、路径或端口",
      "KS_ALERT_URL：必须是有效的 https:// 网址",
      "SUPABASE_PROJECT_REF：格式无效",
      "SUPABASE_URL：必须与 Project Ref 对应",
      "SUPABASE_PUBLISHABLE_KEY：应使用 sb_publishable_ 开头的密钥",
      "SUPABASE_SECRET_KEY：应使用 sb_secret_ 开头的密钥",
      "SUPABASE_ACCESS_TOKEN：应使用 sbp_ 开头的访问令牌",
      "SUPABASE_DB_PASSWORD：至少需要 12 个字符",
      "ADMIN_PASSWORD：至少 32 位，并包含大小写字母、数字和特殊字符",
      "VOTE_IP_SALT：必须是 64 位十六进制随机值",
      "CLOUDFLARE_ACCOUNT_ID：必须是 32 位十六进制 ID",
      "CLOUDFLARE_ZONE_ID：必须是 32 位十六进制 ID",
      "CLOUDFLARE_API_TOKEN：格式无效",
      "CLOUDFLARE_PAGES_PROJECT：只能包含小写字母、数字和连字符",
    ])
  })

  it("parses values containing password symbols without treating them as comments", () => {
    expect(
      parseDeploymentInputs(`
# comment
ADMIN_PASSWORD=Aa2345678901234567890123456789#@!
ROADMAP_DOMAIN="roadmap.example.com"
`),
    ).toEqual({
      ADMIN_PASSWORD: "Aa2345678901234567890123456789#@!",
      ROADMAP_DOMAIN: "roadmap.example.com",
    })
  })
})
