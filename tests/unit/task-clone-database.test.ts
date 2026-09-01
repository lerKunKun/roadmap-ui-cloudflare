import { describe, expect, it } from "vitest"

import {
  buildImportSql,
  buildSnapshotSql,
  buildTargetAuditSql,
  captureSourceSnapshot,
  importSnapshot,
  parseDbQueryJson,
} from "../../scripts/task-clone/database.mjs"

const emptySnapshot = {
  version: 1,
  capturedAt: "2026-09-01T06:00:00.000Z",
  sourceProjectRef: "abcdefghijklmnopqrst",
  projects: [],
  items: [],
  histories: [],
  images: [],
}

describe("task clone database snapshot", () => {
  it("emits one read-only repeatable-read snapshot query", () => {
    const sql = buildSnapshotSql("abcdefghijklmnopqrst")

    expect(sql).toContain(
      "begin transaction isolation level repeatable read read only",
    )
    expect(sql.match(/clock_timestamp\(\)/g)).toHaveLength(1)
    expect(sql).toContain("public.roadmap_vote_count(item.id)")
    expect(sql).toContain("from public.projects")
    expect(sql).toContain("from public.roadmap_items as item")
    expect(sql).toContain("from public.roadmap_status_history")
    expect(sql).toContain("from public.roadmap_item_images")
    expect(sql).not.toContain("from public.votes")
    expect(sql).not.toContain("suggestion_rate_limits")
    expect(sql).not.toContain("suggestion_image_rate_limits")
    expect(sql).not.toContain("auth.users")
    expect(sql.trimEnd()).toMatch(/commit;$/)
  })

  it("parses the bounded JSON returned by the Supabase CLI", () => {
    const output = JSON.stringify({
      boundary: "safe-boundary",
      rows: [{ snapshot: emptySnapshot }],
      warning: "untrusted data",
    })

    expect(parseDbQueryJson(output)).toEqual(emptySnapshot)
  })

  it.each(["", "not-json", JSON.stringify({ rows: [] })])(
    "rejects an invalid database query result",
    (output) => {
      expect(() => parseDbQueryJson(output)).toThrow("数据库快照结果无效")
    },
  )

  it("captures and validates the snapshot without returning provider wrappers", async () => {
    const query = async ({ sql, projectRef }: { sql: string; projectRef: string }) => {
      expect(projectRef).toBe("abcdefghijklmnopqrst")
      expect(sql).toContain("repeatable read read only")
      return {
        stdout: JSON.stringify({ rows: [{ snapshot: emptySnapshot }] }),
      }
    }

    await expect(
      captureSourceSnapshot({
        query,
        sourceRef: "abcdefghijklmnopqrst",
      }),
    ).resolves.toEqual(emptySnapshot)
  })
})

describe("task clone database import", () => {
  const manifest = {
    version: 1,
    capturedAt: "2026-09-01T06:00:00.000Z",
    sourceProjectRef: "abcdefghijklmnopqrst",
    projects: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        name: "包含单引号'的项目",
        slug: "quoted-project",
        projectUrl: null,
        sortOrder: 0,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    ],
    items: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        projectId: "10000000-0000-4000-8000-000000000001",
        title: "导入快照",
        description: "事务导入",
        status: "approved",
        sortOrder: 0,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        voteBaseline: "12",
      },
    ],
    histories: [
      {
        sourceOrder: "9",
        roadmapItemId: "20000000-0000-4000-8000-000000000001",
        fromStatus: null,
        toStatus: "approved",
        changedAt: "2026-08-25T00:00:00.000Z",
      },
    ],
    images: [],
  }

  it("builds an injection-safe all-or-nothing import", () => {
    const sql = buildImportSql(manifest)

    expect(sql).toContain("begin;")
    expect(sql).toContain("pg_advisory_xact_lock")
    expect(sql).toContain("convert_from(decode($snapshot$")
    expect(sql).toContain("jsonb_to_recordset")
    expect(sql).toContain("delete from public.roadmap_status_history")
    expect(sql).toContain("insert into public.roadmap_item_images")
    expect(sql).toContain("from public.votes")
    expect(sql).toContain("from public.suggestion_rate_limits")
    expect(sql).toContain("from public.suggestion_image_rate_limits")
    expect(sql.trimEnd()).toMatch(/commit;$/)
    expect(sql).not.toContain("包含单引号'的项目")
    expect(sql).not.toContain("repeat('a', 64)")
  })

  it("imports through the selected target and accepts only one success row", async () => {
    const query = async ({ projectRef, sql }: { projectRef: string; sql: string }) => {
      expect(projectRef).toBe("bcdefghijklmnopqrstu")
      expect(sql).toContain("pg_advisory_xact_lock")
      return {
        stdout: JSON.stringify({ rows: [{ result: { imported: true } }] }),
      }
    }

    await expect(
      importSnapshot({
        query,
        targetRef: "bcdefghijklmnopqrstu",
        manifest,
      }),
    ).resolves.toEqual({ imported: true })
  })

  it("audits copied and excluded target state in one read-only query", () => {
    const sql = buildTargetAuditSql()

    expect(sql).toContain("repeatable read read only")
    expect(sql).toContain("public.roadmap_vote_count(item.id)")
    expect(sql).toContain("from public.votes")
    expect(sql).toContain("from public.suggestion_rate_limits")
    expect(sql).toContain("from public.suggestion_image_rate_limits")
    expect(sql).toContain("from auth.users")
    expect(sql).toContain("from storage.buckets")
    expect(sql.trimEnd()).toMatch(/commit;$/)
  })
})
