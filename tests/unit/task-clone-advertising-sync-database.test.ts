import { describe, expect, it } from "vitest"

import {
  buildAdvertisingSyncCronSql,
  buildAdvertisingSyncInfrastructureSql,
  buildAdvertisingSyncStatusSql,
  buildAdvertisingSyncTargetTestSql,
  buildAdvertisingSyncVaultSql,
} from "../../scripts/task-clone/advertising-sync-database.mjs"

const TARGET_REF = "bcdefghijklmnopqrstu"

describe("advertising sync target infrastructure", () => {
  it("builds a fixed-scope target transaction with lease and identity guards", () => {
    const sql = buildAdvertisingSyncInfrastructureSql(TARGET_REF)

    expect(sql).toContain("public.roadmap_advertising_sync_state")
    expect(sql).toContain("public.roadmap_advertising_sync_object_cleanup")
    expect(sql).toContain("public.roadmap_advertising_sync_http_requests")
    expect(sql).toContain("public.claim_advertising_roadmap_sync")
    expect(sql).toContain("public.apply_advertising_roadmap_snapshot")
    expect(sql).toContain("public.fail_advertising_roadmap_sync")
    expect(sql).toContain("public.confirm_advertising_object_cleanup")
    expect(sql).toContain("public.record_advertising_object_cleanup_failure")
    expect(sql).toContain("hashtextextended('roadmap:advertising-sync', 0)")
    expect(sql).toContain("interval '15 minutes'")
    expect(sql).toContain(`target_project_ref = '${TARGET_REF}'`)
    expect(sql).toContain("project_slug <> 'advertising-system'")
    expect(sql).toContain("payload_project_slug <> 'advertising-system'")
    expect(sql).toContain("insert into public.roadmap_items")
    expect(sql).toContain("vote_baseline")
    expect(sql).toContain("delete from public.votes")
    expect(sql).toContain("delete from public.roadmap_status_history")
    expect(sql).toContain("insert into public.roadmap_status_history")
    expect(sql).toContain("insert into public.roadmap_item_images")
    expect(sql).toContain(
      "alter table public.roadmap_advertising_sync_state enable row level security"
    )
    expect(sql).toContain(
      "grant execute on function public.apply_advertising_roadmap_snapshot"
    )
    expect(sql).not.toMatch(
      /execute\s+format|\busing\s+payload_project_slug\b/i
    )
  })

  it("rejects invalid target refs before producing SQL", () => {
    expect(() => buildAdvertisingSyncInfrastructureSql("../source")).toThrow(
      "目标 Supabase Project Ref 无效"
    )
  })

  it("renders target infrastructure and rollback-only pgTAP as one executable script", () => {
    const sql = buildAdvertisingSyncTargetTestSql(
      TARGET_REF,
      "begin; select plan(1); select ok(true, 'works'); select * from finish(); rollback;"
    )
    expect(sql).toContain("public.roadmap_clone_import_markers")
    expect(sql).toContain("public.apply_advertising_roadmap_snapshot")
    expect(sql.trimEnd()).toMatch(/rollback;$/)
    expect(() =>
      buildAdvertisingSyncTargetTestSql(TARGET_REF, "select 1")
    ).toThrow("目标同步 pgTAP 测试 SQL 无效")
  })
})

describe("advertising sync Vault and Cron", () => {
  it("stores only the function URL, publishable key, and dedicated cron secret", () => {
    const sql = buildAdvertisingSyncVaultSql({
      functionUrl:
        "https://bcdefghijklmnopqrstu.supabase.co/functions/v1/sync-advertising",
      publishableKey: `sb_publishable_${"p".repeat(32)}`,
      cronSecret: "a".repeat(64),
    })

    expect(sql).toContain("advertising_sync_function_url")
    expect(sql).toContain("advertising_sync_publishable_key")
    expect(sql).toContain("advertising_sync_cron_secret")
    expect(sql).toContain(
      "create extension if not exists supabase_vault with schema vault"
    )
    expect(sql).not.toContain(
      "create extension if not exists vault with schema vault"
    )
    expect(sql).not.toContain("SOURCE_SUPABASE_SECRET_KEY")
    expect(sql).not.toContain("source_secret")
  })

  it("rejects unsafe Vault inputs and any source secret field", () => {
    expect(() =>
      buildAdvertisingSyncVaultSql({
        functionUrl: "https://evil.example/functions/v1/sync-advertising",
        publishableKey: `sb_publishable_${"p".repeat(32)}`,
        cronSecret: "a".repeat(64),
      })
    ).toThrow("同步函数 URL 无效")

    expect(() =>
      buildAdvertisingSyncVaultSql({
        functionUrl:
          "https://bcdefghijklmnopqrstu.supabase.co/functions/v1/sync-advertising",
        publishableKey: `sb_publishable_${"p".repeat(32)}`,
        cronSecret: "a".repeat(64),
        sourceSecretKey: "sb_secret_forbidden",
      } as never)
    ).toThrow("Vault 配置包含禁止字段")
  })

  it("installs one hourly minute-17 job inactive before acceptance", () => {
    const inactive = buildAdvertisingSyncCronSql({ active: false })
    const active = buildAdvertisingSyncCronSql({ active: true })

    for (const sql of [inactive, active]) {
      expect(sql).toContain("sync-advertising-roadmap-hourly")
      expect(sql).toContain("17 * * * *")
      expect(sql).toContain("net.http_post")
      expect(sql).toContain("roadmap_advertising_sync_http_requests")
      expect(sql).toContain("x-roadmap-sync-secret")
      expect(sql).toContain("'apikey'")
    }
    expect(inactive).toContain("active := false")
    expect(active).toContain("active := true")
  })

  it("returns a secret-free status query", () => {
    const sql = buildAdvertisingSyncStatusSql()
    expect(sql).toContain("last_success_at")
    expect(sql).toContain("last_snapshot_digest")
    expect(sql).toContain("cleanup_count")
    expect(sql).toContain("cron.job")
    expect(sql).toContain("net._http_response")
    expect(sql).toContain("status_code")
    expect(sql).not.toContain("error_msg'")
    expect(sql).not.toContain("decrypted_secrets")
  })
})
