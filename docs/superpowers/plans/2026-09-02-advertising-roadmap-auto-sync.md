# 广告系统 Roadmap 自动同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `task.telljax.com` 每小时从 `telljax.com` 单向严格镜像 slug 为 `advertising-system` 的 Roadmap，同时保证 Task 其余项目与源实例完全隔离。

**Architecture:** 在源 Supabase 增加仅 `service_role` 可调用的固定范围快照 RPC；在 Task Supabase 增加目标身份保护、运行租约、严格替换 RPC、同步状态和对象清理队列；目标 `sync-advertising` Edge Function 负责校验、图片哈希/复制、事务替换和补偿清理；目标数据库以 `pg_cron` + `pg_net` 每小时第 17 分钟调用该函数。部署工具只为这个固定源/目标对开放一条受保护的安装、触发、状态、启停和验收路径。

**Tech Stack:** PostgreSQL / PL/pgSQL、Supabase Edge Functions (Deno + TypeScript)、Supabase Storage、Vault、`pg_cron`、`pg_net`、Zod 4、Node.js ESM、Vitest、pgTAP、Cloudflare Pages（现有前端不改）。

**Spec:** `docs/superpowers/specs/2026-09-02-advertising-roadmap-auto-sync-design.md`

## Global Constraints

- 同步方向固定为源 `dcrpfvmbrauvertdmkey` → 目标 `esrdavzqjsbzkhtdfohx`，运行时仍从忽略的部署文件读取并复核，不在源码中保存 Secret Key。
- 唯一可同步 slug 是 `advertising-system`；任何 payload、CLI 参数或 HTTP body 都不能改变此范围。
- 源端除安装只读导出函数外只允许 RPC 与私有 Storage 读取；不得写入源项目数据、Auth、Vault、Cron 或 Edge Secrets。
- 每次成功同步严格覆盖 Task 的广告系统项目、条目、时间轴、图片元数据和累计票数；Task 在该项目的本地建议、修改和投票被清除。
- Task 其他项目及其条目、时间轴、图片、投票和建议不得被同步 SQL 读取、更新、删除或重排。
- 源快照缺失、为空、超限、图片冲突或任何校验失败时必须失败关闭，保留 Task 上一次成功版本。
- 源 Secret Key 只进入目标 Edge Secrets 和本机忽略文件；不得进入 Vault、Pages、Git、状态表、错误正文或日志。
- Cron 首次安装为 inactive；只有手动同步与隔离验收全部通过后才能启用 `17 * * * *`。
- 所有数据库替换使用固定 SQL/RPC、事务、目标复制标记与运行租约；不使用动态表名或用户指定 Project Ref。
- 每个实现任务遵循 RED → GREEN → focused verification → 中文提交；完成前使用 `superpowers:verification-before-completion`，合并前使用代码审查技能。

---

### Task 1: Source-Only Advertising Snapshot RPC

**Files:**
- Create: `supabase/migrations/20260902090000_advertising_sync_export.sql`
- Create: `supabase/tests/database/advertising-sync-export.test.sql`
- Modify: `tests/unit/task-clone-providers.test.ts`
- Modify: `scripts/task-clone/providers.mjs`

**Interfaces:**

```sql
public.export_advertising_roadmap_snapshot() returns jsonb
```

```js
supabase.applyProtectedSourceMigration({
  projectRef,
  region,
  databasePassword,
  migrationPath,
  expectedSha256,
})
```

- [ ] **Step 1: Write the failing pgTAP contract for the export function**

Create `advertising-sync-export.test.sql` with a transaction fixture containing an advertising item, one status transition, one vote baseline plus two runtime votes, one image metadata row, and an unrelated-project item. Assert:

```sql
select has_function(
  'public',
  'export_advertising_roadmap_snapshot',
  array[]::text[],
  'advertising export RPC exists'
);
select ok(
  not has_function_privilege('anon', 'public.export_advertising_roadmap_snapshot()', 'execute'),
  'anon cannot export the snapshot'
);
select ok(
  has_function_privilege('service_role', 'public.export_advertising_roadmap_snapshot()', 'execute'),
  'service role can export the snapshot'
);
select is(
  (public.export_advertising_roadmap_snapshot() #>> '{project,slug}'),
  'advertising-system',
  'the fixed advertising project is exported'
);
```

Also assert exactly one project object, no unrelated UUID/title, stable item/history/image order, public votes represented as decimal strings, and no keys named `ip`, `ip_hash`, `secret`, `token`, `auth`, or `votes` anywhere in the JSON.

- [ ] **Step 2: Run the database suite and verify RED**

```powershell
npm run supabase:test
```

Expected: FAIL because `public.export_advertising_roadmap_snapshot()` does not exist.

- [ ] **Step 3: Implement a fixed-scope, single-statement snapshot function**

The migration must use a PL/pgSQL `stable security definer` function with `set search_path = ''`. It must load and validate the unique fixed project inside one function invocation, raise before building a payload when the match count is not one, and build every array with explicit ordering. The returned shape is:

```json
{
  "version": 1,
  "capturedAt": "2026-09-02T00:00:00.000Z",
  "project": {
    "id": "uuid",
    "name": "广告系统",
    "slug": "advertising-system",
    "projectUrl": null,
    "sortOrder": 0,
    "createdAt": "timestamp",
    "updatedAt": "timestamp"
  },
  "items": [],
  "histories": [],
  "images": []
}
```

Use `public.roadmap_vote_count(item.id)::text` as `voteBaseline`; never select `public.votes` directly. Export history `id::text` only as `sourceOrder`, and image metadata without object bytes or hashes. End the migration with:

```sql
revoke all on function public.export_advertising_roadmap_snapshot() from public;
grant execute on function public.export_advertising_roadmap_snapshot() to service_role;
```

- [ ] **Step 4: Add a narrowly scoped source-migration provider test**

Test that `applyProtectedSourceMigration` accepts only the exact normalized path `supabase/migrations/20260902090000_advertising_sync_export.sql`, requires the caller-provided SHA-256 to match the file bytes, requires `projectRef === protectedProjectRef`, and rejects a file containing table DML, Auth, Vault, Cron, Storage writes, or any second SQL statement outside the approved function/grant/revoke/comment DDL. Verify the provider error never prints SQL or credentials.

- [ ] **Step 5: Run focused tests and implement the guarded provider method**

```powershell
npm run test:run -- tests/unit/task-clone-providers.test.ts
```

Expected RED: `applyProtectedSourceMigration` is missing.

Implement the method using the existing pinned-CA PostgreSQL client, a fixed allow-listed path, SHA-256 verification, and a transaction. Do not weaken `queryDatabase` or `assertMutableProject`; the new method is the only source-DDL exception.

- [ ] **Step 6: Verify and commit**

```powershell
npm run supabase:test
npm run test:run -- tests/unit/task-clone-providers.test.ts
git add supabase/migrations/20260902090000_advertising_sync_export.sql supabase/tests/database/advertising-sync-export.test.sql scripts/task-clone/providers.mjs tests/unit/task-clone-providers.test.ts
git diff --cached --check
git commit -m "数据库：导出广告系统同步快照"
```

---

### Task 2: Snapshot Validation, Identity, Authentication, and Stable Digest

**Files:**
- Create: `supabase/functions/_shared/advertising-sync-model.ts`
- Create: `supabase/functions/_shared/advertising-sync-security.ts`
- Create: `tests/unit/advertising-sync-model.test.ts`
- Create: `tests/unit/advertising-sync-security.test.ts`

**Interfaces:**

```ts
export const advertisingSnapshotSchema: z.ZodType<AdvertisingSnapshot>
export const hydratedAdvertisingSnapshotSchema: z.ZodType<HydratedAdvertisingSnapshot>
export function parseAdvertisingSnapshot(value: unknown): AdvertisingSnapshot
export async function digestAdvertisingSnapshot(value: HydratedAdvertisingSnapshot): Promise<string>
export function assertSourceIdentity(url: string, projectRef: string): URL
export function hasValidSyncSecret(provided: string | null, expected: string): boolean
export function safeSyncError(error: unknown): { code: SyncErrorCode; message: string }
```

- [ ] **Step 1: Write failing schema tests for the complete contract**

Use one minimal valid fixture and table-driven mutations. Require:

- exactly one project object and slug exactly `advertising-system`;
- max 5,000 items, 50,000 histories, 5,000 images;
- every UUID, foreign key, status, date, sort order and `voteBaseline` decimal string is valid;
- image path follows the existing `suggestions/{uuid}/{uuid}.(jpg|png)` rule;
- image MIME is JPEG/PNG, each size is `1..4,999,999`, dimensions obey current limits, and total logical image bytes are at most `1_000_000_000`;
- hydrated images require lowercase 64-character `sha256`;
- duplicate IDs, paths, one-image-per-item violations, unknown references, unsafe integers, extra top-level keys, and forbidden sensitive keys fail.

Test that digest output is stable across object-key insertion order but changes for any business field, vote baseline, history, image metadata, or image hash.

- [ ] **Step 2: Write failing source-identity and constant-time secret tests**

Require only `https://{projectRef}.supabase.co` with no username, non-default port, path, query, fragment, alternate hostname, suffix trick, mixed Project Ref, or source/target equality. Use an injected timing-safe comparison adapter to prove equal-length byte arrays are always compared and length mismatch fails without comparing partial values.

Expected safe errors are fixed codes such as `UNAUTHORIZED`, `SOURCE_IDENTITY_INVALID`, `SNAPSHOT_INVALID`, `SOURCE_UNAVAILABLE`, `IMAGE_CONFLICT`, `TARGET_APPLY_FAILED`, and `SYNC_BUSY`; messages must not include upstream response bodies, snapshot text, URLs with credentials, or Secret values.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/advertising-sync-model.test.ts tests/unit/advertising-sync-security.test.ts
```

- [ ] **Step 4: Implement strict Zod schemas and Web Crypto digesting**

Use Zod from the existing Deno import map. Canonicalize values into arrays sorted by stable keys before `JSON.stringify`, then hash UTF-8 bytes through `crypto.subtle.digest("SHA-256", bytes)`. Do not reuse the one-time clone manifest model because this contract permits one project only and has different size/failure semantics.

Implement constant-time comparison by SHA-256 hashing both UTF-8 secrets first, then XOR-reducing the two equal-length digest arrays. Reject expected secrets shorter than 32 characters before request handling.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:run -- tests/unit/advertising-sync-model.test.ts tests/unit/advertising-sync-security.test.ts
git add supabase/functions/_shared/advertising-sync-model.ts supabase/functions/_shared/advertising-sync-security.ts tests/unit/advertising-sync-model.test.ts tests/unit/advertising-sync-security.test.ts
git diff --cached --check
git commit -m "函数：校验广告系统同步快照"
```

---

### Task 3: Target-Only State, Lease, Strict Apply RPC, and Cron SQL

**Files:**
- Create: `scripts/task-clone/advertising-sync-database.mjs`
- Create: `tests/unit/task-clone-advertising-sync-database.test.ts`
- Create: `supabase/tests/target/advertising-sync-target.test.sql`
- Modify: `scripts/task-clone/database.mjs`

**Interfaces:**

```js
export function buildAdvertisingSyncInfrastructureSql(targetRef)
export function buildAdvertisingSyncVaultSql({ functionUrl, publishableKey, cronSecret })
export function buildAdvertisingSyncCronSql({ active })
export function buildAdvertisingSyncStatusSql()
export function buildAdvertisingSyncTargetTestSql(targetRef)
```

```sql
public.claim_advertising_roadmap_sync(run_id uuid) returns boolean
public.apply_advertising_roadmap_snapshot(
  run_id uuid,
  snapshot jsonb,
  snapshot_digest text,
  duration_ms integer
) returns jsonb
public.fail_advertising_roadmap_sync(
  run_id uuid,
  error_code text,
  error_message text,
  duration_ms integer
) returns void
public.confirm_advertising_object_cleanup(paths text[]) returns void
public.record_advertising_object_cleanup_failure(path text, error_code text) returns void
```

- [ ] **Step 1: Write failing SQL-builder unit tests**

Assert the generated target infrastructure:

- validates a 20-character target ref and embeds it only as a quoted fixed clone-marker check;
- creates `roadmap_advertising_sync_state` with the required timestamps, digest, counts, duration and safe error columns plus `active_run_id`/`active_started_at` for a 15-minute stale lease;
- creates `roadmap_advertising_sync_object_cleanup` with path, enqueue time, attempts and latest error;
- enables RLS, revokes `anon`/`authenticated`, and grants only `service_role` execution;
- uses a fixed advisory-lock key and a persisted lease so concurrent HTTP invocations are rejected before source/image work;
- never uses dynamic SQL, a payload slug in a `where` clause, or an input Project Ref;
- applies/delete scopes through the current advertising project ID and explicit item-ID sets;
- checks source project, item and image UUID collisions against every non-advertising target row before deletion;
- deletes Task advertising votes/rate-limit-independent content, preserves unrelated projects, and writes source public totals to `vote_baseline`;
- temporarily suppresses trigger-generated histories, then restores the supplied ordered history exactly;
- queues only old advertising image paths and removes current snapshot paths from the queue;
- validates insert counts before updating success state and committing.

Assert Vault SQL contains only `advertising_sync_function_url`, `advertising_sync_publishable_key`, and `advertising_sync_cron_secret`; it must never accept or contain a source Secret Key. Assert Cron SQL uses name `sync-advertising-roadmap-hourly`, schedule `17 * * * *`, `net.http_post`, `apikey`, and `x-roadmap-sync-secret`, and can install inactive before later activation.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-advertising-sync-database.test.ts
```

Expected: FAIL because the target-only builder does not exist.

- [ ] **Step 3: Implement target tables and RPCs as deterministic SQL**

The apply RPC must begin with the equivalent of:

```sql
if not pg_try_advisory_xact_lock(hashtextextended('roadmap:advertising-sync', 0)) then
  raise exception 'advertising_sync_busy' using errcode = '55P03';
end if;

if not exists (
  select 1
  from public.roadmap_clone_import_markers
  where singleton and target_project_ref = 'esrdavzqjsbzkhtdfohx'
) then
  raise exception 'advertising_sync_target_identity_invalid' using errcode = '42501';
end if;
```

The builder must substitute the validated runtime target ref; the literal above is only the current production expectation. Decode snapshot rows with `jsonb_to_record` / `jsonb_to_recordset` and explicit column types. Use no interpolated title, description, URL, path, or UUID text.

`claim_advertising_roadmap_sync` serializes claims under the same advisory key, returns false for a live lease, and takes over only when `active_started_at < clock_timestamp() - interval '15 minutes'`. `fail_*` may clear only its own `active_run_id`, truncates safe error messages to 500 characters, and cannot overwrite a newer run.

- [ ] **Step 4: Write the target pgTAP behavior suite**

`buildAdvertisingSyncTargetTestSql(targetRef)` must concatenate the production target-only infrastructure SQL with `supabase/tests/target/advertising-sync-target.test.sql` into a temporary test input; do not duplicate RPC DDL in the test file. The pgTAP test creates:

- source-shaped advertising project/items/history/image payload;
- Task-local advertising suggestion, vote, and image path that should disappear;
- unrelated sentinel project/item/history/vote/image that must remain byte-for-byte unchanged.

Assert a successful apply produces exact source-shaped advertising rows, empty advertising runtime votes, correct `vote_baseline`, exact histories, cleanup-queue behavior, and success state. Assert invalid slug, missing project, UUID collision, illegal image, count mismatch, wrong lease run ID, and target marker mismatch all roll back. Test `anon`/`authenticated` denial and a second claim returning false while the first lease is live.

- [ ] **Step 5: Add and run an isolated target database-test command**

Add the implementation helper so a later package script can execute the rendered SQL against a disposable local Supabase database, always removing the temporary file in `finally`. For this task run:

```powershell
npm run test:run -- tests/unit/task-clone-advertising-sync-database.test.ts
npm run supabase:test
```

The dedicated target test command is wired in Task 6; until then, verify its rendered SQL contains the complete pgTAP plan and ends in `rollback`.

- [ ] **Step 6: Verify and commit**

```powershell
git add scripts/task-clone/advertising-sync-database.mjs scripts/task-clone/database.mjs tests/unit/task-clone-advertising-sync-database.test.ts supabase/tests/target/advertising-sync-target.test.sql
git diff --cached --check
git commit -m "数据库：严格替换目标广告系统"
```

---

### Task 4: Private Image Hashing, Copy, Reuse, and Compensation

**Files:**
- Create: `supabase/functions/_shared/advertising-sync-storage.ts`
- Create: `tests/unit/advertising-sync-storage.test.ts`

**Interfaces:**

```ts
export type AdvertisingStorageDependencies = {
  downloadSource(path: string): Promise<{ bytes: Uint8Array; contentType: string }>
  downloadTarget(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  uploadTarget(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  removeTarget(paths: string[]): Promise<void>
}

export async function prepareAdvertisingImages(
  snapshot: AdvertisingSnapshot,
  deps: AdvertisingStorageDependencies,
): Promise<{ snapshot: HydratedAdvertisingSnapshot; uploadedPaths: string[] }>

export async function compensateUploadedImages(
  paths: string[],
  deps: Pick<AdvertisingStorageDependencies, "removeTarget">,
): Promise<void>
```

- [ ] **Step 1: Write failing storage tests with generated bytes**

Cover:

- percent-encoding every Storage path segment and fixed private bucket `roadmap-images`;
- source response MIME and byte length matching snapshot metadata;
- a hard read ceiling of 5,000,000 bytes before hashing;
- lowercase SHA-256 placed in a new immutable hydrated snapshot;
- absent target object uploaded with overwrite disabled and recorded in `uploadedPaths`;
- existing target object reused only when MIME, byte length, and SHA-256 all match;
- same-path different bytes raise `IMAGE_CONFLICT` and never overwrite;
- any source/download/upload failure removes only objects uploaded by this invocation, in reverse order;
- compensation failure reports path/count and a safe error code without response bodies or authorization headers;
- no more than three image transfers run concurrently.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/advertising-sync-storage.test.ts
```

- [ ] **Step 3: Implement bounded fetch adapters and orchestration**

Provide adapter factories using the source and target Supabase URLs/Secret Keys internally, but expose only byte-oriented dependencies to the pure function. For uploads set `x-upsert: false`, `content-type`, `apikey`, and bearer Secret Key. A 404 on target means absent; any other non-2xx response is a safe provider error.

Process images in stable path order with a concurrency pool of three. On failure, await all already-started transfers, collect only successful new uploads, remove them, then throw the original safe error unless cleanup itself is the only failure.

- [ ] **Step 4: Verify and commit**

```powershell
npm run test:run -- tests/unit/advertising-sync-storage.test.ts
git add supabase/functions/_shared/advertising-sync-storage.ts tests/unit/advertising-sync-storage.test.ts
git diff --cached --check
git commit -m "函数：同步广告系统私有图片"
```

---

### Task 5: Edge Function Orchestration and Failure Recovery

**Files:**
- Create: `supabase/functions/_shared/advertising-sync-runner.ts`
- Create: `supabase/functions/sync-advertising/index.ts`
- Create: `tests/unit/advertising-sync-runner.test.ts`
- Create: `tests/unit/advertising-sync-function.test.ts`
- Modify: `scripts/test-local-functions.mjs`

**Interfaces:**

```ts
export type AdvertisingSyncDependencies = {
  claim(runId: string): Promise<boolean>
  fetchSnapshot(): Promise<unknown>
  prepareImages(snapshot: AdvertisingSnapshot): Promise<PreparedImages>
  apply(runId: string, snapshot: HydratedAdvertisingSnapshot, digest: string, durationMs: number): Promise<ApplyResult>
  fail(runId: string, code: string, message: string, durationMs: number): Promise<void>
  cleanupQueuedObjects(): Promise<CleanupResult>
  compensate(paths: string[]): Promise<void>
  now(): number
  randomUuid(): string
}

export async function runAdvertisingSync(deps: AdvertisingSyncDependencies): Promise<SyncResult>
export function createAdvertisingSyncHandler(deps?: Partial<RuntimeDependencies>): (request: Request) => Promise<Response>
```

- [ ] **Step 1: Write failing runner state-machine tests**

Assert exact event ordering:

1. claim lease;
2. fetch source snapshot, retrying a network/RPC failure once only;
3. validate before any image operation;
4. prepare/hash/copy images;
5. compute digest and call target apply once;
6. process queued old-object cleanup;
7. return counts, digest prefix and duration.

Cover busy lease → 409/no source read, invalid snapshot → no retry/no target change, image failure → compensation/no apply, target apply failure → compensation plus `fail`, ambiguous apply response → audit status before compensation, old-object cleanup failure → successful DB sync with queued cleanup remaining, and failure-state recording itself failing without hiding the primary safe error.

- [ ] **Step 2: Write failing HTTP/security/runtime tests**

Require `POST` only; the request carries the target publishable `apikey` for the Supabase endpoint, while missing/invalid `x-roadmap-sync-secret` returns 401 before environment/source initialization. Unit tests must not treat the publishable key as the authorization boundary because the function is deployed with `--no-verify-jwt`. Validate all five required Edge Secrets, exact source/target refs, and source/target inequality. Responses contain only:

```json
{
  "ok": true,
  "runId": "uuid",
  "digest": "12-char-prefix",
  "counts": { "items": 0, "histories": 0, "images": 0 },
  "durationMs": 123
}
```

Logs may include run ID, stage, counts, digest prefix and safe code only. Test with a capturing logger that titles, descriptions, object bytes, full URLs, headers, keys and passwords never appear.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/advertising-sync-runner.test.ts tests/unit/advertising-sync-function.test.ts
```

- [ ] **Step 4: Implement the pure runner and thin Edge entry point**

Use `createClient` with source Secret Key only for `rpc("export_advertising_roadmap_snapshot")`; use a separate target service client for claim/apply/failure/cleanup RPCs. The request body is ignored except for JSON syntactic validity and cannot select a slug or project.

Map safe outcomes to HTTP: 200 success (including queued cleanup warning), 401 unauthorized, 409 busy, 422 invalid snapshot/identity, 502 source/image provider failure, and 500 target apply failure. Deploy with `--no-verify-jwt`; still require the custom secret before initializing clients.

- [ ] **Step 5: Extend local black-box coverage**

Teach `scripts/test-local-functions.mjs` to test only unauthorized/method behavior for `sync-advertising` unless explicit source/target integration variables are set. It must never default production refs or keys into local tests.

```powershell
npm run test:run -- tests/unit/advertising-sync-runner.test.ts tests/unit/advertising-sync-function.test.ts
npm run test:functions
```

- [ ] **Step 6: Verify and commit**

```powershell
git add supabase/functions/_shared/advertising-sync-runner.ts supabase/functions/sync-advertising/index.ts tests/unit/advertising-sync-runner.test.ts tests/unit/advertising-sync-function.test.ts scripts/test-local-functions.mjs
git diff --cached --check
git commit -m "函数：执行广告系统单向同步"
```

---

### Task 6: Safe Configuration, Deployment, Manual Trigger, Status, and Cron Control

**Files:**
- Modify: `scripts/task-clone/config.mjs`
- Modify: `scripts/task-clone/providers.mjs`
- Modify: `scripts/task-clone/run.mjs`
- Create: `scripts/task-clone/advertising-sync.mjs`
- Create: `tests/unit/task-clone-advertising-sync.test.ts`
- Modify: `tests/unit/task-clone-config.test.ts`
- Modify: `tests/unit/task-clone-providers.test.ts`
- Modify: `tests/unit/task-clone-run.test.ts`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**

```js
export function generateTargetSecrets(randomBytes) // adds advertisingSyncCronSecret
export async function installAdvertisingSync(context)
export async function triggerAdvertisingSync(context)
export async function statusAdvertisingSync(context)
export async function setAdvertisingSyncCronActive(context, active)
```

**Commands:**

```text
npm run sync:advertising:install
npm run sync:advertising:trigger
npm run sync:advertising:status
npm run sync:advertising:enable
npm run sync:advertising:disable
npm run supabase:test:advertising-target
```

- [ ] **Step 1: Write failing config tests for the new local secret**

Add `ADVERTISING_SYNC_CRON_SECRET` to `.env.task.deploy.local` serialization. Generate 32 random bytes as 64 lowercase hex characters. Require source/target refs to remain the known independent pair, reject reuse of any source credential, and ensure parsing/errors never reveal values. Existing target files without this key may be upgraded only when their target ref equals the configured Task ref; use atomic mode-0600 replacement.

- [ ] **Step 2: Write failing provider and CLI orchestration tests**

Test that install performs exactly:

1. validate source/target identity and current clone marker;
2. checksum and apply the one approved source migration;
3. apply target-only infrastructure with Cron absent/inactive;
4. set target Edge Secrets (`ADVERTISING_SYNC_CRON_SECRET`, source URL/key/ref, target ref) without changing existing vote/origin secrets;
5. deploy only `sync-advertising` in addition to the existing function list;
6. write only the three allowed Vault values;
7. create/update the named Cron job inactive;
8. query status and report `installed=true`, `active=false`.

Prove any identity mismatch stops before mutation. Prove no provider call sends source Secret Key to target Vault, Cloudflare, command output, receipt, or status query. Prove `enable` refuses unless the last success digest exists, cleanup queue is empty, and a current acceptance receipt matches source ref, target ref, app commit and snapshot digest.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-config.test.ts tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts tests/unit/task-clone-advertising-sync.test.ts
```

- [ ] **Step 4: Implement dedicated provider methods without broadening source mutation**

Add focused methods rather than expanding `setEdgeSecrets` into an untyped bag:

```js
supabase.setAdvertisingSyncEdgeSecrets({
  targetProjectRef,
  cronSecret,
  sourceUrl,
  sourceSecretKey,
  sourceProjectRef,
})
supabase.deployEdgeFunction(targetProjectRef, "sync-advertising")
supabase.applyAdvertisingSyncInfrastructure({ targetProjectRef, sql })
supabase.configureAdvertisingSyncVault({ targetProjectRef, sql })
supabase.configureAdvertisingSyncCron({ targetProjectRef, sql, active })
```

Every target method calls `assertMutableProject`; every source operation goes through the Task 1 allow-listed migration method. Temporary secret files use `mkdtemp`, mode 0600, and `finally` removal. Provider errors expose only operation, status/request ID and safe code.

- [ ] **Step 5: Implement CLI stages and package scripts**

`advertising-sync.mjs` accepts only `install|trigger|status|enable|disable|test-target`; no slug/ref flags. `trigger` posts to `https://{targetRef}.supabase.co/functions/v1/sync-advertising` using target publishable key and the dedicated header. `status` performs a read-only target SQL query and prints timestamps, counts, duration, digest prefix, error code, cleanup count, Cron schedule/active flag, and latest `pg_net` status—never secret values or error details containing data.

Render the target pgTAP SQL from Task 3 to a temporary file for `supabase:test:advertising-target`, run it against a disposable local Supabase database, and remove the file in `finally`. This command must refuse any host not equal to local Supabase.

- [ ] **Step 6: Document only placeholder names in `.env.example`**

Add comments describing that `.env.task.deploy.local` receives `ADVERTISING_SYNC_CRON_SECRET` automatically. Do not add a real ref, URL, publishable key, Secret Key, database password, admin password, or cron secret to the committed example.

- [ ] **Step 7: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-config.test.ts tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts tests/unit/task-clone-advertising-sync.test.ts
npm run supabase:test:advertising-target
git add scripts/task-clone/config.mjs scripts/task-clone/providers.mjs scripts/task-clone/run.mjs scripts/task-clone/advertising-sync.mjs tests/unit/task-clone-config.test.ts tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts tests/unit/task-clone-advertising-sync.test.ts package.json .env.example
git diff --cached --check
git commit -m "部署：管理广告系统自动同步"
```

---

### Task 7: Reversible Production Isolation Acceptance and Operations Documentation

**Files:**
- Create: `scripts/task-clone/advertising-sync-acceptance.mjs`
- Create: `tests/unit/task-clone-advertising-sync-acceptance.test.ts`
- Modify: `scripts/task-clone/advertising-sync.mjs`
- Modify: `package.json`
- Modify: `docs/deployment.md`

**Interfaces:**

```js
export async function acceptAdvertisingSync(context): Promise<AcceptanceReceipt>
```

```text
npm run sync:advertising:acceptance
```

- [ ] **Step 1: Write a failing acceptance-orchestration test**

Inject all database, HTTP and Storage adapters. Require the script to:

- read a source before-snapshot and never call a mutable source method;
- create a uniquely prefixed Task non-advertising sentinel project with item, history, vote and optional generated PNG;
- record the complete sentinel rows/object hash;
- manually trigger sync and reconcile every advertising project/item/history/image field and public vote count;
- compare every advertising image SHA-256;
- assert the sentinel is unchanged;
- assert the source before/after snapshot digest and source runtime counts are unchanged;
- add a Task-local advertising suggestion and vote, trigger again, and prove both disappear;
- assert successful state, empty cleanup queue and inactive Cron before enable;
- delete only generated sentinel/test fixtures in `finally`, checking exact UUIDs/prefixes before deletion;
- write an ignored receipt only after cleanup and all assertions succeed.

Test every failure boundary to ensure cleanup runs and a failed acceptance never creates a valid enable receipt.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-advertising-sync-acceptance.test.ts
```

- [ ] **Step 3: Implement production acceptance with fixed identities**

Use source snapshot RPC and source Storage downloads only. Use target service operations only for generated fixtures and readback. Generate the optional 2×2 PNG in memory; never reuse or delete a customer object. The receipt goes to ignored `.task-roadmap-advertising-sync-acceptance.json` and contains only refs, app commit, snapshot digest, counts, timestamps and boolean checks—no titles, descriptions, object bytes, IP hashes or secrets.

- [ ] **Step 4: Add an operations section**

Document in `docs/deployment.md`:

- fixed source/target/domain and strict advertising-only semantics;
- hourly schedule at minute 17 and expected delay;
- installation, manual trigger, acceptance, status, enable and disable commands;
- state/error-code interpretation and cleanup-queue handling;
- failure-closed behavior and why Task advertising local edits disappear;
- source-key and cron-secret rotation order;
- rollback by disabling Cron first, then reverting function/RPC while preserving last good Task data;
- Task other-project isolation and the prohibition on reverse sync.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-advertising-sync-acceptance.test.ts
git add scripts/task-clone/advertising-sync-acceptance.mjs scripts/task-clone/advertising-sync.mjs tests/unit/task-clone-advertising-sync-acceptance.test.ts package.json docs/deployment.md
git diff --cached --check
git commit -m "验收：验证广告系统同步隔离"
```

---

### Task 8: Full Verification, Review, Production Rollout, and Clean Push

**Files:**
- Runtime only: ignored `.env.deploy.local`, `.env.task.deploy.local`, acceptance receipt, Supabase resources and temporary test files.
- No committed file should change during rollout except review fixes.

- [ ] **Step 1: Run the complete local verification matrix**

Use `superpowers:verification-before-completion` and capture fresh output:

```powershell
npm run test:run
npm run supabase:test
npm run supabase:test:advertising-target
npm run test:functions
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npx wrangler pages functions build --outdir .wrangler/functions-build
git diff --check
```

Expected: all tests, pgTAP assertions, lint, types, static export and Pages Function bundle pass. After local database tests, stop Supabase and remove only the local Supabase containers/volumes created by this repository; verify no local Supabase Docker resources remain.

- [ ] **Step 2: Request implementation review and resolve findings**

Use `superpowers:requesting-code-review`. Review specifically for source writes, source/target confusion, arbitrary slug/ref injection, migration allow-list bypass, unsafe SQL interpolation, lease races, transaction scope leaks, unrelated-project mutation, trigger-created duplicate histories, runtime vote leakage, bigint precision, Storage overwrite, partial-upload compensation, cleanup queue races, Secret leakage, Cron authentication, `--no-verify-jwt` exposure, and false-success status.

Apply valid findings with `superpowers:receiving-code-review`, add regression tests first, rerun focused suites, and repeat Step 1.

- [ ] **Step 3: Verify commit history before production mutation**

```powershell
git status --short --branch
git log --oneline origin/master..master
```

Require only Chinese task commits, no secret/untracked deployment file staged, and no unrelated user changes. Do not push yet if rollout needs a review fix.

- [ ] **Step 4: Install the source RPC and target infrastructure with Cron inactive**

```powershell
npm run sync:advertising:install
npm run sync:advertising:status
```

Expected: source export RPC callable only by service role; target tables/RPCs and Edge secrets installed; `sync-advertising` deployed; Vault has only three allowed sync values; Cron job exists with `17 * * * *` and `active=false`; no source project data, Auth or runtime state changes.

- [ ] **Step 5: Manually trigger and perform reversible isolation acceptance**

```powershell
npm run sync:advertising:trigger
npm run sync:advertising:acceptance
npm run sync:advertising:status
```

Require advertising project equality after both synchronization passes, identical image hashes and public vote totals, deletion of target-local advertising suggestion/vote, unchanged Task sentinel, unchanged source digest/counts, successful status, and an empty cleanup queue. Cron must still be inactive.

- [ ] **Step 6: Enable hourly Cron and observe one scheduled run**

```powershell
npm run sync:advertising:enable
npm run sync:advertising:status
```

Verify the job is active with the exact schedule. Wait until the next minute-17 execution without blocking user communication for more than 60 seconds at a time; then require a newer `last_attempt_at`, successful `pg_net` response, unchanged/error-free digest semantics, and an empty cleanup queue. If the scheduled run fails, disable Cron immediately and retain the last good Task data for diagnosis.

- [ ] **Step 7: Re-run production read-only checks**

```powershell
npm run deploy:task:check
npm run sync:advertising:status
```

Smoke `https://telljax.com/`, `https://task.telljax.com/`, and both admin routes. Confirm existing vote, suggestion, image modal/cache and login behavior remain unchanged. Compare a fresh source/target advertising snapshot and one unrelated Task project again.

- [ ] **Step 8: Finish and push a clean master branch**

Use `superpowers:finishing-a-development-branch`, then:

```powershell
git status --short --branch
git push origin master
git status --short --branch
```

Expected: `master` is clean and synchronized with `origin/master`. Final handoff reports the pushed commit, Cron schedule/active state, last-success time/digest prefix/counts, isolation acceptance result, and whether the cleanup queue is empty. Do not repeat administrator passwords or any sync Secret unless the user explicitly asks.
