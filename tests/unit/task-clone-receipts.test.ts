import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  createCopyReceipt,
  datasetDigests,
  readCopyReceipt,
  readSmokeReceipt,
  writeReceiptAtomic,
} from "../../scripts/task-clone/receipts.mjs"

describe("task clone receipts", () => {
  it("creates a secret-free receipt tied to both refs, object hashes, and commit", () => {
    const manifest = {
      version: 1,
      capturedAt: "2026-09-01T06:00:00.000Z",
      sourceProjectRef: "abcdefghijklmnopqrst",
      projects: [],
      items: [],
      histories: [],
      images: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          roadmapItemId: "20000000-0000-4000-8000-000000000001",
          storagePath: "suggestions/a/b.png",
          sha256: "a".repeat(64),
          sizeBytes: 10,
          mimeType: "image/png",
          width: 2,
          height: 2,
          createdAt: "2026-09-01T06:00:00.000Z",
        },
      ],
    }
    const receipt = createCopyReceipt({
      manifest,
      targetProjectRef: "bcdefghijklmnopqrstu",
      appCommit: "f".repeat(40),
    })

    expect(receipt).toMatchObject({
      version: 1,
      sourceProjectRef: "abcdefghijklmnopqrst",
      targetProjectRef: "bcdefghijklmnopqrstu",
      appCommit: "f".repeat(40),
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      counts: { projects: 0, items: 0, histories: 0, images: 1 },
    })
    expect(JSON.stringify(receipt)).not.toMatch(/secret|password|token|salt/i)
  })

  it("writes atomically and rejects a malformed receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-receipt-"))
    const path = join(directory, ".env.task.copy.local")
    const receipt = createCopyReceipt({
      manifest: {
        version: 1,
        capturedAt: "2026-09-01T06:00:00.000Z",
        sourceProjectRef: "abcdefghijklmnopqrst",
        projects: [],
        items: [],
        histories: [],
        images: [],
      },
      targetProjectRef: "bcdefghijklmnopqrstu",
      appCommit: "f".repeat(40),
    })

    await writeReceiptAtomic(path, receipt)
    await expect(readCopyReceipt(path)).resolves.toEqual(receipt)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt)
  })

  it("rejects a smoke receipt from any non-target URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-smoke-receipt-"))
    const path = join(directory, ".env.task.smoke.local")
    await writeReceiptAtomic(path, {
      version: 1,
      baseUrl: "https://example.com/",
      targetProjectRef: "bcdefghijklmnopqrstu",
      appCommit: "f".repeat(40),
      copyDigest: "a".repeat(64),
      completedAt: "2026-09-01T06:00:00.000Z",
    })

    await expect(readSmokeReceipt(path)).rejects.toThrow("冒烟回执无效")
  })

  it("changes the relational digest when data changes without changing counts", () => {
    const value = {
      projects: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          name: "广告系统",
          slug: "advertising-system",
          projectUrl: null,
          sortOrder: 0,
          createdAt: "2026-09-01T06:00:00.000Z",
          updatedAt: "2026-09-01T06:00:00.000Z",
        },
      ],
      items: [],
      histories: [],
      images: [],
    }
    const before = datasetDigests(value)
    const after = datasetDigests({
      ...value,
      projects: [{ ...value.projects[0], name: "被篡改但数量相同" }],
    })

    expect(after.projects).not.toBe(before.projects)
    expect(after.items).toBe(before.items)
  })

  it("derives current object digests from Storage metadata, not image rows", () => {
    const images = [
      {
        id: "30000000-0000-4000-8000-000000000001",
        roadmapItemId: "20000000-0000-4000-8000-000000000001",
        storagePath: "suggestions/a/b.png",
        sizeBytes: 10,
        mimeType: "image/png",
        width: 2,
        height: 2,
        createdAt: "2026-09-01T06:00:00.000Z",
      },
    ]
    const base = { projects: [], items: [], histories: [], images }
    const expected = datasetDigests(base, {
      "suggestions/a/b.png": "a".repeat(64),
    })
    const drifted = datasetDigests(
      {
        ...base,
        storageObjects: [
          {
            name: "suggestions/a/b.png",
            sizeBytes: 999,
            mimeType: "text/plain",
          },
        ],
      },
      { "suggestions/a/b.png": "a".repeat(64) },
    )

    expect(drifted.objects).not.toBe(expected.objects)
  })
})
