import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { runCaptured } from "./command.mjs"
import { parseDbQueryColumn } from "./database.mjs"
import {
  ADVERTISING_SYNC_ACCEPTANCE_RECEIPT_FILE,
  loadAdvertisingSyncRuntime,
  triggerAdvertisingSync,
} from "./advertising-sync.mjs"
import { removeReceipt, writeReceiptAtomic } from "./receipts.mjs"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const STORAGE_PATH_PATTERN =
  /^suggestions\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    )
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value))
}

function iso(value) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("广告验收时间字段无效")
  return parsed.toISOString()
}

function sortRows(rows) {
  return [...rows].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  )
}

function normalizeAdvertisingEvidence(input) {
  if (
    input?.version !== 1 ||
    input?.project?.slug !== "advertising-system" ||
    !Array.isArray(input.items) ||
    !Array.isArray(input.histories) ||
    !Array.isArray(input.images)
  ) {
    throw new Error("广告系统验收快照无效")
  }
  const project = input.project
  return {
    version: 1,
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      projectUrl: project.projectUrl ?? null,
      sortOrder: Number(project.sortOrder),
      createdAt: iso(project.createdAt),
      updatedAt: iso(project.updatedAt),
    },
    items: sortRows(
      input.items.map((item) => ({
        id: item.id,
        projectId: item.projectId,
        title: item.title,
        description: item.description,
        status: item.status,
        sortOrder: Number(item.sortOrder),
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
        voteBaseline: String(item.voteBaseline),
      }))
    ),
    histories: sortRows(
      input.histories.map((history) => ({
        roadmapItemId: history.roadmapItemId,
        fromStatus: history.fromStatus ?? null,
        toStatus: history.toStatus,
        changedAt: iso(history.changedAt),
      }))
    ),
    images: sortRows(
      input.images.map((image) => ({
        id: image.id,
        roadmapItemId: image.roadmapItemId,
        storagePath: image.storagePath,
        mimeType: image.mimeType,
        sizeBytes: Number(image.sizeBytes),
        width: Number(image.width),
        height: Number(image.height),
        createdAt: iso(image.createdAt),
      }))
    ),
  }
}

export function assertAdvertisingEvidenceEqual(source, target) {
  if (
    canonicalJson(normalizeAdvertisingEvidence(source)) !==
    canonicalJson(normalizeAdvertisingEvidence(target))
  ) {
    throw new Error("目标广告系统与源不一致")
  }
}

function assertSameSource(before, after) {
  if (
    before?.contentDigest !== after?.contentDigest ||
    canonicalJson(before?.counters) !== canonicalJson(after?.counters)
  ) {
    throw new Error("源 Roadmap 在广告同步验收期间发生变化")
  }
}

function assertSameSentinel(before, after) {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error("Task 非广告项目在同步期间发生变化")
  }
}

function assertSafeStatus(status) {
  if (
    !SHA256_PATTERN.test(status?.lastSnapshotDigest ?? "") ||
    status?.cleanupCount !== 0 ||
    status?.cronActive !== false ||
    status?.busy !== false ||
    status?.lastErrorCode !== null
  ) {
    throw new Error("广告同步状态不满足启用条件")
  }
}

export async function acceptAdvertisingSync(adapters) {
  await adapters.clearReceipt()
  const startedAt = adapters.now().toISOString()
  const sourceBefore = await adapters.readSourceEvidence()
  let sentinel = null
  let localAdvertisingMutation = null
  let sentinelBefore = null
  let pendingReceipt = null
  let failure = null

  try {
    sentinel = await adapters.createSentinel()
    sentinelBefore = await adapters.readSentinel(sentinel)

    await adapters.trigger()
    const sourceAfterFirst = await adapters.readSourceEvidence()
    assertSameSource(sourceBefore, sourceAfterFirst)
    const targetAfterFirst = await adapters.readTargetAdvertising()
    assertAdvertisingEvidenceEqual(sourceBefore.snapshot, targetAfterFirst)
    await adapters.assertImageHashesEqual(sourceBefore.snapshot)
    assertSameSentinel(sentinelBefore, await adapters.readSentinel(sentinel))

    localAdvertisingMutation = await adapters.createLocalAdvertisingMutation()
    await adapters.trigger()
    if (
      await adapters.localAdvertisingMutationExists(localAdvertisingMutation)
    ) {
      throw new Error("Task 本地广告条目未被严格镜像移除")
    }

    const sourceAfterSecond = await adapters.readSourceEvidence()
    assertSameSource(sourceBefore, sourceAfterSecond)
    const targetAfterSecond = await adapters.readTargetAdvertising()
    assertAdvertisingEvidenceEqual(sourceBefore.snapshot, targetAfterSecond)
    await adapters.assertImageHashesEqual(sourceBefore.snapshot)
    assertSameSentinel(sentinelBefore, await adapters.readSentinel(sentinel))

    const status = await adapters.readStatus()
    assertSafeStatus(status)
    pendingReceipt = {
      version: 1,
      sourceProjectRef: adapters.sourceProjectRef,
      targetProjectRef: adapters.targetProjectRef,
      appCommit: adapters.appCommit,
      snapshotDigest: status.lastSnapshotDigest,
      counts: {
        projects: 1,
        items: sourceBefore.snapshot.items.length,
        histories: sourceBefore.snapshot.histories.length,
        images: sourceBefore.snapshot.images.length,
      },
      startedAt,
      completedAt: adapters.now().toISOString(),
      checks: {
        advertisingEqual: true,
        imageHashesEqual: true,
        sourceUnchanged: true,
        targetSentinelUnchanged: true,
        targetLocalAdvertisingRemoved: true,
        cleanupQueueEmpty: true,
        cronInactive: true,
      },
    }
  } catch (error) {
    failure = error
  } finally {
    if (sentinel) {
      try {
        await adapters.cleanupFixtures({ sentinel, localAdvertisingMutation })
      } catch (cleanupError) {
        failure = failure
          ? new AggregateError(
              [failure, cleanupError],
              "广告同步验收与清理失败"
            )
          : cleanupError
      }
    }
  }

  if (failure) throw failure
  if (!pendingReceipt) throw new Error("广告同步验收未生成有效回执")
  await adapters.writeReceipt(pendingReceipt)
  return pendingReceipt
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(value ?? "")) throw new Error(`${label} UUID 无效`)
  return value
}

function assertSentinelSlug(value) {
  if (!/^sync-acceptance-[0-9a-f]{32}$/.test(value ?? "")) {
    throw new Error("广告同步哨兵前缀无效")
  }
  return value
}

function fixtureIdentity() {
  const projectId = randomUUID()
  return {
    projectId,
    itemId: randomUUID(),
    voteId: randomUUID(),
    slug: `sync-acceptance-${projectId.replaceAll("-", "")}`,
  }
}

function localAdvertisingIdentity() {
  return { itemId: randomUUID(), voteId: randomUUID() }
}

export function buildCreateSentinelSql(identity, targetProjectRef) {
  const projectId = assertUuid(identity?.projectId, "哨兵项目")
  const itemId = assertUuid(identity?.itemId, "哨兵条目")
  const voteId = assertUuid(identity?.voteId, "哨兵投票")
  const slug = assertSentinelSlug(identity?.slug)
  if (!/^[a-z0-9]{20}$/.test(targetProjectRef ?? "")) {
    throw new Error("哨兵目标项目无效")
  }
  return `begin;
select pg_advisory_xact_lock(hashtextextended('roadmap:advertising-sync-acceptance', 0));
do $guard$
begin
  if not exists (
    select 1 from public.roadmap_clone_import_markers
    where singleton and target_project_ref = '${targetProjectRef}'
  ) then
    raise exception 'advertising_sync_acceptance_target_invalid';
  end if;
  if exists (select 1 from public.projects where id = '${projectId}'::uuid or slug = '${slug}')
    or exists (select 1 from public.roadmap_items where id = '${itemId}'::uuid)
    or exists (select 1 from public.votes where id = '${voteId}'::uuid)
  then
    raise exception 'advertising_sync_acceptance_fixture_conflict';
  end if;
end;
$guard$;
insert into public.projects (id, name, slug, project_url, sort_order)
values ('${projectId}'::uuid, '同步隔离验收', '${slug}', 'https://task.telljax.com/', 2147480000);
insert into public.roadmap_items (
  id, project_id, title, description, status, sort_order, vote_baseline
)
values (
  '${itemId}'::uuid, '${projectId}'::uuid, '同步隔离验收条目',
  '仅由自动验收生成并精确清理', 'pending', 0, 7
);
update public.roadmap_items set status = 'completed' where id = '${itemId}'::uuid;
insert into public.votes (id, roadmap_item_id, ip_hash)
values ('${voteId}'::uuid, '${itemId}'::uuid, repeat('a', 64));
commit;`
}

export function buildReadSentinelSql(identity) {
  const projectId = assertUuid(identity?.projectId, "哨兵项目")
  const itemId = assertUuid(identity?.itemId, "哨兵条目")
  const voteId = assertUuid(identity?.voteId, "哨兵投票")
  const slug = assertSentinelSlug(identity?.slug)
  return `select jsonb_build_object(
  'project', (select to_jsonb(project) from public.projects as project
    where project.id = '${projectId}'::uuid and project.slug = '${slug}'),
  'item', (select to_jsonb(item) from public.roadmap_items as item
    where item.id = '${itemId}'::uuid and item.project_id = '${projectId}'::uuid),
  'histories', coalesce((select jsonb_agg(to_jsonb(history) order by history.id)
    from public.roadmap_status_history as history
    where history.roadmap_item_id = '${itemId}'::uuid), '[]'::jsonb),
  'votes', coalesce((select jsonb_agg(to_jsonb(vote_row) order by vote_row.id)
    from public.votes as vote_row
    where vote_row.id = '${voteId}'::uuid and vote_row.roadmap_item_id = '${itemId}'::uuid), '[]'::jsonb)
) as sentinel;`
}

export function buildCreateLocalAdvertisingSql(identity) {
  const itemId = assertUuid(identity?.itemId, "本地广告条目")
  const voteId = assertUuid(identity?.voteId, "本地广告投票")
  return `begin;
select pg_advisory_xact_lock(hashtextextended('roadmap:advertising-sync-acceptance', 0));
insert into public.roadmap_items (
  id, project_id, title, description, status, sort_order, vote_baseline
)
select '${itemId}'::uuid, project.id, 'Task 本地广告验收条目',
  '应在下一次严格同步中被移除', 'pending', 2147480000, 0
from public.projects as project
where project.slug = 'advertising-system';
insert into public.votes (id, roadmap_item_id, ip_hash)
values ('${voteId}'::uuid, '${itemId}'::uuid, repeat('b', 64));
commit;`
}

export function buildLocalAdvertisingExistsSql(identity) {
  const itemId = assertUuid(identity?.itemId, "本地广告条目")
  const voteId = assertUuid(identity?.voteId, "本地广告投票")
  return `select jsonb_build_object(
  'exists', exists (select 1 from public.roadmap_items where id = '${itemId}'::uuid)
    or exists (select 1 from public.votes where id = '${voteId}'::uuid)
    or exists (select 1 from public.roadmap_status_history where roadmap_item_id = '${itemId}'::uuid)
) as local_fixture;`
}

export function buildCleanupAcceptanceSql({
  sentinel,
  localAdvertisingMutation,
}) {
  const projectId = assertUuid(sentinel?.projectId, "哨兵项目")
  const itemId = assertUuid(sentinel?.itemId, "哨兵条目")
  const voteId = assertUuid(sentinel?.voteId, "哨兵投票")
  const slug = assertSentinelSlug(sentinel?.slug)
  const localItemId = localAdvertisingMutation
    ? assertUuid(localAdvertisingMutation.itemId, "本地广告条目")
    : "00000000-0000-4000-8000-000000000000"
  const localVoteId = localAdvertisingMutation
    ? assertUuid(localAdvertisingMutation.voteId, "本地广告投票")
    : "00000000-0000-4000-8000-000000000000"
  return `begin;
select pg_advisory_xact_lock(hashtextextended('roadmap:advertising-sync-acceptance', 0));
delete from public.votes where id in ('${voteId}'::uuid, '${localVoteId}'::uuid);
delete from public.roadmap_status_history
where roadmap_item_id in ('${itemId}'::uuid, '${localItemId}'::uuid);
delete from public.roadmap_items
where id = '${localItemId}'::uuid
  or (id = '${itemId}'::uuid and project_id = '${projectId}'::uuid);
delete from public.projects where id = '${projectId}'::uuid and slug = '${slug}';
do $verify$
begin
  if exists (select 1 from public.projects where id = '${projectId}'::uuid or slug = '${slug}')
    or exists (select 1 from public.roadmap_items where id in ('${itemId}'::uuid, '${localItemId}'::uuid))
    or exists (select 1 from public.votes where id in ('${voteId}'::uuid, '${localVoteId}'::uuid))
  then
    raise exception 'advertising_sync_acceptance_cleanup_incomplete';
  end if;
end;
$verify$;
commit;`
}

export function buildSourceEvidenceSql() {
  return `select jsonb_build_object(
  'snapshot', public.export_advertising_roadmap_snapshot(),
  'counters', jsonb_build_object(
    'projects', (select count(*) from public.projects),
    'items', (select count(*) from public.roadmap_items),
    'histories', (select count(*) from public.roadmap_status_history),
    'images', (select count(*) from public.roadmap_item_images),
    'votes', (select count(*) from public.votes),
    'suggestionRateLimits', (select count(*) from public.suggestion_rate_limits),
    'imageRateLimits', (select count(*) from public.suggestion_image_rate_limits),
    'storageObjects', (select count(*) from storage.objects where bucket_id = 'roadmap-images'),
    'authUsers', (select count(*) from auth.users)
  )
) as evidence;`
}

export function buildTargetAdvertisingEvidenceSql() {
  return `with advertising_project as (
  select * from public.projects where slug = 'advertising-system'
)
select jsonb_build_object(
  'version', 1,
  'project', (select jsonb_build_object(
    'id', project.id, 'name', project.name, 'slug', project.slug,
    'projectUrl', project.project_url, 'sortOrder', project.sort_order,
    'createdAt', project.created_at, 'updatedAt', project.updated_at
  ) from advertising_project as project),
  'items', coalesce((select jsonb_agg(jsonb_build_object(
    'id', item.id, 'projectId', item.project_id, 'title', item.title,
    'description', item.description, 'status', item.status,
    'sortOrder', item.sort_order, 'createdAt', item.created_at,
    'updatedAt', item.updated_at,
    'voteBaseline', public.roadmap_vote_count(item.id)::text
  ) order by item.id) from public.roadmap_items as item
  where item.project_id = (select id from advertising_project)), '[]'::jsonb),
  'histories', coalesce((select jsonb_agg(jsonb_build_object(
    'roadmapItemId', history.roadmap_item_id,
    'fromStatus', history.from_status, 'toStatus', history.to_status,
    'changedAt', history.changed_at
  ) order by history.roadmap_item_id, history.changed_at, history.id)
  from public.roadmap_status_history as history
  join public.roadmap_items as item on item.id = history.roadmap_item_id
  where item.project_id = (select id from advertising_project)), '[]'::jsonb),
  'images', coalesce((select jsonb_agg(jsonb_build_object(
    'id', image.id, 'roadmapItemId', image.roadmap_item_id,
    'storagePath', image.storage_path, 'mimeType', image.mime_type,
    'sizeBytes', image.size_bytes, 'width', image.width,
    'height', image.height, 'createdAt', image.created_at
  ) order by image.id) from public.roadmap_item_images as image
  join public.roadmap_items as item on item.id = image.roadmap_item_id
  where item.project_id = (select id from advertising_project)), '[]'::jsonb)
) as evidence;`
}

function contentDigest(snapshot) {
  return createHash("sha256")
    .update(canonicalJson(normalizeAdvertisingEvidence(snapshot)))
    .digest("hex")
}

async function queryColumn(query, sql, column, operation, readOnly = false) {
  const result = await query({ sql, operation, readOnly })
  return parseDbQueryColumn(result.stdout, column, `${operation}结果无效`)
}

function storageUrl(baseUrl, path) {
  if (!STORAGE_PATH_PATTERN.test(path ?? "")) {
    throw new Error("广告验收图片路径无效")
  }
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  return `${baseUrl}/storage/v1/object/roadmap-images/${encoded}`
}

async function objectHash(baseUrl, secretKey, image) {
  const headers = { apikey: secretKey }
  if (!secretKey.startsWith("sb_")) {
    headers.authorization = `Bearer ${secretKey}`
  }
  const response = await fetch(storageUrl(baseUrl, image.storagePath), {
    headers,
  })
  if (!response.ok)
    throw new Error(`广告验收图片读取失败（HTTP ${response.status}）`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (
    bytes.byteLength !== Number(image.sizeBytes) ||
    bytes.byteLength >= 5_000_000
  ) {
    throw new Error("广告验收图片字节数无效")
  }
  return createHash("sha256").update(bytes).digest("hex")
}

async function assertProductionImageHashes(runtime, snapshot) {
  for (const image of snapshot.images) {
    const [sourceHash, targetHash] = await Promise.all([
      objectHash(
        runtime.sourceInputs.SUPABASE_URL,
        runtime.sourceInputs.SUPABASE_SECRET_KEY,
        image
      ),
      objectHash(
        runtime.targetInputs.SUPABASE_URL,
        runtime.targetInputs.SUPABASE_SECRET_KEY,
        image
      ),
    ])
    if (sourceHash !== targetHash) throw new Error("广告系统图片哈希不一致")
  }
}

function createProductionAdapters(runtime, appCommit) {
  const targetQuery = (input) => runtime.targetQuery(input)
  return {
    sourceProjectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
    targetProjectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
    appCommit,
    now: () => new Date(),
    clearReceipt: () => removeReceipt(ADVERTISING_SYNC_ACCEPTANCE_RECEIPT_FILE),
    async readSourceEvidence() {
      const evidence = await queryColumn(
        runtime.sourceQuery,
        buildSourceEvidenceSql(),
        "evidence",
        "读取源广告验收证据",
        true
      )
      return {
        ...evidence,
        contentDigest: contentDigest(evidence.snapshot),
      }
    },
    async createSentinel() {
      const identity = fixtureIdentity()
      await targetQuery({
        sql: buildCreateSentinelSql(
          identity,
          runtime.targetInputs.SUPABASE_PROJECT_REF
        ),
        operation: "创建 Task 隔离验收哨兵",
      })
      return identity
    },
    readSentinel(identity) {
      return queryColumn(
        targetQuery,
        buildReadSentinelSql(identity),
        "sentinel",
        "读取 Task 隔离验收哨兵",
        true
      )
    },
    trigger: () =>
      triggerAdvertisingSync({
        sourceProjectRef: runtime.sourceInputs.SUPABASE_PROJECT_REF,
        targetProjectRef: runtime.targetInputs.SUPABASE_PROJECT_REF,
        targetUrl: runtime.targetInputs.SUPABASE_URL,
        publishableKey: runtime.targetInputs.SUPABASE_PUBLISHABLE_KEY,
        cronSecret: runtime.targetInputs.ADVERTISING_SYNC_CRON_SECRET,
      }),
    readTargetAdvertising: () =>
      queryColumn(
        targetQuery,
        buildTargetAdvertisingEvidenceSql(),
        "evidence",
        "读取 Task 广告系统验收证据",
        true
      ),
    assertImageHashesEqual: (snapshot) =>
      assertProductionImageHashes(runtime, snapshot),
    async createLocalAdvertisingMutation() {
      const identity = localAdvertisingIdentity()
      await targetQuery({
        sql: buildCreateLocalAdvertisingSql(identity),
        operation: "创建 Task 本地广告验收条目",
      })
      return identity
    },
    async localAdvertisingMutationExists(identity) {
      const result = await queryColumn(
        targetQuery,
        buildLocalAdvertisingExistsSql(identity),
        "local_fixture",
        "核对 Task 本地广告验收条目",
        true
      )
      return result.exists === true
    },
    readStatus: runtime.readStatus,
    cleanupFixtures: ({ sentinel, localAdvertisingMutation }) =>
      targetQuery({
        sql: buildCleanupAcceptanceSql({ sentinel, localAdvertisingMutation }),
        operation: "清理 Task 广告同步验收数据",
      }),
    writeReceipt: (receipt) =>
      writeReceiptAtomic(ADVERTISING_SYNC_ACCEPTANCE_RECEIPT_FILE, receipt),
  }
}

async function main() {
  const runtime = await loadAdvertisingSyncRuntime()
  const appCommit = (
    await runCaptured("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      operation: "读取广告同步验收提交",
    })
  ).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(appCommit)) throw new Error("验收提交无效")
  const receipt = await acceptAdvertisingSync(
    createProductionAdapters(runtime, appCommit)
  )
  process.stdout.write(
    `广告系统隔离验收通过：digest=${receipt.snapshotDigest.slice(0, 12)} items=${receipt.counts.items} images=${receipt.counts.images}\n`
  )
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : ""
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
