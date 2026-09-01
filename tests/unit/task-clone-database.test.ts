import { describe, expect, it } from "vitest"

import {
  buildSnapshotSql,
  captureSourceSnapshot,
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
