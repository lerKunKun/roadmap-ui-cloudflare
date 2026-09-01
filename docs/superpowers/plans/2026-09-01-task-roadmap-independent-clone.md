# Task Roadmap Independent Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a fully independent copy of the current Roadmap at `https://task.telljax.com/`, preserve the current business data and public vote totals once, exclude every historical IP-derived record and source administrator, and hand over a new administrator account.

**Architecture:** The existing `master` codebase builds a second Cloudflare Pages project named `task-roadmap-ui`. A new Supabase project named `task-roadmap` owns its database, private image bucket, Auth account, Edge Functions, passwords, and salts. A source-safe `vote_baseline` migration preserves aggregate vote totals without copying vote hashes. A temporary, secret-safe clone runner captures one read-only database snapshot, copies only referenced image objects with SHA-256 verification, imports the snapshot into the fresh target, reconciles it, and removes its temporary files.

**Tech Stack:** Next.js 16 static export, React 19, TypeScript 5, Supabase Postgres/Auth/Storage/Edge Functions, Supabase CLI 2.x Management API query path, Cloudflare Pages/Functions/DNS API, Node.js 22, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-task-roadmap-independent-clone-design.md`

## Global Constraints

- Do not change, delete, truncate, or copy credentials from the source Supabase project. The only source database mutation is the additive `vote_baseline` migration with a default of zero.
- Copy `projects`, `roadmap_items`, status history, image metadata, referenced private image objects, and aggregate public vote totals. Never copy `votes`, `suggestion_rate_limits`, `suggestion_image_rate_limits`, `auth.users`, sessions, IP values, IP hashes, source passwords, source project secrets, or the source `VOTE_IP_SALT`.
- Keep source and target on the same application commit. Do not create a long-lived source-code fork or a second repository.
- Keep `roadmap-images` private. Never log snapshot record bodies, object bytes, signed URLs, database passwords, access tokens, secret keys, administrator passwords, or salts.
- Create `.env.task.deploy.local` atomically and rely on the existing `.env*` ignore rule. It contains target-only runtime credentials; account-level Supabase and Cloudflare management tokens continue to be read transiently from `.env.deploy.local` and are not copied into the target file.
- Do not recreate local Supabase Docker resources. Database tests and migrations target the linked cloud projects.
- Treat `task.telljax.com` as unavailable until reconciliation and the `pages.dev` smoke test pass. Stop before changing DNS if an existing `task.telljax.com` record or Pages custom-domain binding conflicts.
- Use Chinese commit messages. Do not push until tests, lint, typecheck, production build, security review, and copy reconciliation pass. Finish with clean, synchronized `master`.
- Never print the new administrator password during implementation. Return the admin URL, email, and password exactly once in the final user-facing handoff.

---

## File Map

- Create `supabase/migrations/20260901090000_roadmap_vote_baseline.sql`: additive vote baseline and aggregate function replacement.
- Create `supabase/tests/database/vote-baseline.test.sql`: baseline, additive votes, invalid values, permissions, and cascade contract.
- Modify `scripts/deployment-inputs.mjs`: allow an explicit input path without changing the default source deployment check.
- Modify `tests/unit/deployment-inputs.test.ts`: explicit-path and secret-safe validation coverage.
- Create `scripts/task-clone/config.mjs`: source/target configuration schemas, credential generation, and atomic target file handling.
- Create `scripts/task-clone/command.mjs`: captured subprocess runner that redacts command failures.
- Create `tests/unit/task-clone-config.test.ts`: generated credentials, fixed target identity, and no-secret diagnostics.
- Create `scripts/task-clone/model.mjs`: clone-manifest schema, normalization, reference checks, and reconciliation model.
- Create `scripts/task-clone/database.mjs`: Management API database-query adapter, read-only snapshot SQL, import SQL, and target audit SQL.
- Create `tests/unit/task-clone-model.test.ts`: manifest scope, baseline mapping, relation validation, and reconciliation tests.
- Create `tests/unit/task-clone-database.test.ts`: snapshot/import SQL safety and CLI result parsing tests.
- Create `scripts/task-clone/storage.mjs`: private object download/upload/hash verification and compensating cleanup.
- Create `tests/unit/task-clone-storage.test.ts`: success, corruption, missing source, unexpected target, and cleanup tests.
- Create `scripts/task-clone/providers.mjs`: injected Supabase Management/Auth and Cloudflare Pages/DNS operations.
- Create `tests/unit/task-clone-providers.test.ts`: request shape, conflict handling, secret redaction, and idempotency tests.
- Create `scripts/task-clone/run.mjs`: staged `prepare`, `copy`, `deploy`, `domain`, and `status` orchestration.
- Create `tests/unit/task-clone-run.test.ts`: stage ordering, retry, resume refusal, and failure cleanup tests.
- Create `scripts/task-clone/smoke.mjs`: disposable target-only production smoke workflow and cleanup.
- Create `tests/unit/task-clone-smoke.test.ts`: target isolation, assertions, and unconditional cleanup tests.
- Modify `package.json`: focused clone commands.
- Modify `docs/deployment.md`: document the independent target, repeatable deployment path, verification, and rollback.

---

### Task 1: Preserve Aggregate Votes Without Copying IP Hashes

**Files:**
- Create: `supabase/migrations/20260901090000_roadmap_vote_baseline.sql`
- Create: `supabase/tests/database/vote-baseline.test.sql`

**Interfaces:**
- Adds `public.roadmap_items.vote_baseline bigint not null default 0`.
- Keeps `public.roadmap_vote_count(uuid) -> bigint` and every public view/API shape unchanged.

- [ ] **Step 1: Write the failing pgTAP contract**

Use fixed project/item UUIDs inside `begin`/`rollback`. Assert the new column exists, is `bigint`, is not nullable, defaults to zero, rejects a negative value, and is not present in `roadmap_items_public`. Insert an item with baseline 7 and two different valid vote hashes, then assert public `vote_count = 9`. Delete the item and assert both vote rows cascade.

```sql
select col_type_is(
  'public', 'roadmap_items', 'vote_baseline', 'bigint',
  'vote baseline uses bigint'
);
select col_default_is(
  'public', 'roadmap_items', 'vote_baseline', '0',
  'vote baseline defaults to zero'
);
select is(
  public.roadmap_vote_count('10000000-0000-4000-8000-000000000009'),
  9::bigint,
  'public total is baseline plus new target votes'
);
```

- [ ] **Step 2: Run the isolated test and verify RED**

Load `SUPABASE_ACCESS_TOKEN`, project ref, and database password from `.env.deploy.local` into process memory without echoing them. Run the test against the linked source cloud project. Expected: failure because `vote_baseline` does not exist.

```powershell
npx supabase test db supabase/tests/database/vote-baseline.test.sql --db-url $roadmapPoolerUrl
```

- [ ] **Step 3: Implement the additive migration**

```sql
alter table public.roadmap_items
  add column vote_baseline bigint not null default 0
  check (vote_baseline >= 0);

create or replace function public.roadmap_vote_count(target_item_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select item.vote_baseline
      from public.roadmap_items as item
      where item.id = target_item_id
    ), 0::bigint)
    + (
      select count(*)::bigint
      from public.votes
      where roadmap_item_id = target_item_id
    )
$$;

revoke all on function public.roadmap_vote_count(uuid) from public;
grant execute on function public.roadmap_vote_count(uuid)
  to anon, authenticated, service_role;
```

Do not recreate either public view: both existing view definitions call the replaced function and therefore retain their columns while returning the new aggregate.

- [ ] **Step 4: Verify locally defined and source-cloud behavior**

Before migration, capture a map of source item UUID to public `vote_count` in memory. Dry-run and require exactly this migration, apply it to the source, run all three pgTAP files plus the new file, then capture the map again and require byte-for-byte equality after stable UUID sorting.

```powershell
npx supabase db push --linked --project-ref $sourceRef --dry-run
npx supabase db push --linked --project-ref $sourceRef --yes
npx supabase test db supabase/tests/database/roadmap.test.sql --db-url $roadmapPoolerUrl
npx supabase test db supabase/tests/database/status-history.test.sql --db-url $roadmapPoolerUrl
npx supabase test db supabase/tests/database/suggestion-images.test.sql --db-url $roadmapPoolerUrl
npx supabase test db supabase/tests/database/vote-baseline.test.sql --db-url $roadmapPoolerUrl
```

- [ ] **Step 5: Commit the compatibility contract**

```powershell
git add supabase/migrations/20260901090000_roadmap_vote_baseline.sql supabase/tests/database/vote-baseline.test.sql
git diff --cached --check
git commit -m "功能：支持 Roadmap 历史票数基线"
```

---

### Task 2: Target Configuration and Secret-Safe Command Boundaries

**Files:**
- Modify: `scripts/deployment-inputs.mjs`
- Modify: `tests/unit/deployment-inputs.test.ts`
- Create: `scripts/task-clone/config.mjs`
- Create: `scripts/task-clone/command.mjs`
- Create: `tests/unit/task-clone-config.test.ts`
- Modify: `package.json`

**Interfaces:**

```js
export function readDeploymentInputs(path = ".env.deploy.local")
export function validateTaskIdentity(source, target)
export function generateTargetSecrets(randomBytes)
export function writeTargetInputsAtomic(path, values)
export async function runCaptured(program, args, options)
```

The target file contains exactly `ROADMAP_DOMAIN`, `CLOUDFLARE_PAGES_PROJECT`, `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `VOTE_IP_SALT`. It does not contain either provider's account-level token.

- [ ] **Step 1: Write failing configuration tests**

Prove that:

- `readDeploymentInputs()` still defaults to `.env.deploy.local`;
- an explicit `.env.task.deploy.local` path is supported;
- target domain must equal `task.telljax.com`, Pages project must equal `task-roadmap-ui`, and target ref must differ from source ref;
- generated DB/admin passwords are at least 32 characters with upper/lower/digit/symbol classes;
- generated salt is 64 lowercase hexadecimal characters and differs from the source salt;
- diagnostics contain field names only, never supplied values;
- atomic writing refuses to overwrite an existing target file unless `expectedProjectRef` matches, and never writes a partial file.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/deployment-inputs.test.ts tests/unit/task-clone-config.test.ts
```

- [ ] **Step 3: Implement configuration and subprocess helpers**

Use `randomBytes(24).toString("base64url")` plus independently selected required character classes for each password and `randomBytes(32).toString("hex")` for the salt. Serialize values using JSON-quoted `.env` values so `#`, `$`, and `=` remain literal. Write to a sibling temporary file, flush, rename atomically, and set restrictive permissions where supported.

`runCaptured` must pass secrets through `env` or stdin, never command arguments when a CLI supports stdin. It returns `{ stdout, stderr, exitCode }`; on failure it throws a stable error containing only the executable, operation label, exit code, and redacted provider request ID.

- [ ] **Step 4: Add package commands**

```json
{
  "deploy:task:check": "node scripts/task-clone/run.mjs status",
  "deploy:task:prepare": "node scripts/task-clone/run.mjs prepare",
  "deploy:task:copy": "node scripts/task-clone/run.mjs copy",
  "deploy:task:deploy": "node scripts/task-clone/run.mjs deploy",
  "deploy:task:domain": "node scripts/task-clone/run.mjs domain",
  "deploy:task:smoke": "node scripts/task-clone/smoke.mjs"
}
```

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:run -- tests/unit/deployment-inputs.test.ts tests/unit/task-clone-config.test.ts
npm run deploy:check
git add package.json scripts/deployment-inputs.mjs scripts/task-clone/config.mjs scripts/task-clone/command.mjs tests/unit/deployment-inputs.test.ts tests/unit/task-clone-config.test.ts
git diff --cached --check
git commit -m "工具：校验 Task Roadmap 部署配置"
```

---

### Task 3: Consistent Source Snapshot and Clone Manifest

**Files:**
- Create: `scripts/task-clone/model.mjs`
- Create: `scripts/task-clone/database.mjs`
- Create: `tests/unit/task-clone-model.test.ts`
- Create: `tests/unit/task-clone-database.test.ts`

**Interfaces:**

```js
export function parseCloneManifest(value)
export function validateCloneManifest(manifest)
export function buildSnapshotSql()
export function parseDbQueryJson(stdout)
export async function captureSourceSnapshot({ query, sourceRef })
```

Manifest version 1 has this shape:

```ts
interface CloneManifestV1 {
  version: 1
  capturedAt: string
  sourceProjectRef: string
  projects: Array<{ id: string; name: string; slug: string; projectUrl: string | null; sortOrder: number; createdAt: string; updatedAt: string }>
  items: Array<{ id: string; projectId: string; title: string; description: string; status: string; sortOrder: number; createdAt: string; updatedAt: string; voteBaseline: string }>
  histories: Array<{ sourceOrder: string; roadmapItemId: string; fromStatus: string | null; toStatus: string; changedAt: string }>
  images: Array<{ id: string; roadmapItemId: string; storagePath: string; mimeType: "image/jpeg" | "image/png"; sizeBytes: number; width: number; height: number; createdAt: string; sha256: string | null }>
}
```

- [ ] **Step 1: Write failing model tests**

Cover valid normalization; string-preserved bigint vote totals; duplicate UUID/path rejection; missing project/item references; invalid status/MIME/size/path; nonzero, negative, or unsafe-number baseline rejection; and explicit rejection of keys named `ip`, `ip_hash`, `votes`, `suggestion_rate_limits`, `suggestion_image_rate_limits`, `auth`, `password`, `token`, `secret`, or `salt` anywhere in the manifest.

- [ ] **Step 2: Write failing snapshot-adapter tests**

Assert that `buildSnapshotSql()` contains `begin transaction isolation level repeatable read read only`, one `clock_timestamp()` capture, stable ordering for all arrays, `public.roadmap_vote_count(item.id)`, and only the four approved source tables/views. Assert it does not select from the three excluded IP-derived tables or `auth.users`. Test Management API JSON success, warning-prefixed output, empty result, malformed result, and provider error without echoing provider bodies.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
```

- [ ] **Step 4: Implement one-statement JSON snapshot SQL**

Build the manifest in one SQL statement inside a read-only repeatable-read transaction. For each collection, use an ordered aggregate in the form `coalesce(jsonb_agg(to_jsonb(ordered_row) order by ordered_row.id), '[]'::jsonb)`. Cast vote counts and history identity values to text. Return exactly one `snapshot` JSON column, then commit.

Invoke it through:

```text
npx supabase db query --linked --project-ref {sourceRef} --file {temporarySql} --output-format json
```

Set `SUPABASE_ACCESS_TOKEN` only in the child environment. Store the SQL and manifest under `mkdtemp(join(tmpdir(), "task-roadmap-clone-"))`; do not write either inside the repository. Log only capture time and collection counts.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
git add scripts/task-clone/model.mjs scripts/task-clone/database.mjs tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
git diff --cached --check
git commit -m "工具：生成 Roadmap 数据复制快照"
```

---

### Task 4: Verified Private Image Copy

**Files:**
- Create: `scripts/task-clone/storage.mjs`
- Create: `tests/unit/task-clone-storage.test.ts`

**Interfaces:**

```js
export async function hydrateImageHashes({ manifest, source, fetchImpl })
export async function copyImageObjects({ manifest, target, fetchImpl })
export async function removeCopiedObjects({ paths, target, fetchImpl })
```

- [ ] **Step 1: Write failing storage tests**

Use injected `fetchImpl` and generated bytes. Prove:

- source downloads percent-encode each path segment and authenticate with the source secret;
- the actual content type and byte length must equal metadata;
- SHA-256 is lowercase hexadecimal and is added to a new immutable manifest;
- upload uses the same path, target secret, MIME, and no overwrite;
- a missing/deleted source object produces the retriable code `SOURCE_SNAPSHOT_STALE`;
- an unexpected target object stops before overwrite;
- hash or length mismatch removes every object uploaded by this invocation in reverse order;
- cleanup failure is reported as a target-only path/count list and never reveals headers or bodies.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-storage.test.ts
```

- [ ] **Step 3: Implement source verification and target copy**

Download through `/storage/v1/object/roadmap-images/{encodedPath}` using `apikey` and bearer server credentials. Read at most `5_000_000` bytes, require exact metadata length and MIME, compute SHA-256, then upload to the identical target path with `x-upsert: false`. Before the first upload, list target bucket objects and require that no manifest path already exists.

Use at most three concurrent object transfers. If any source object disappears, delete the temporary manifest and signal the runner to discard the database snapshot and start a new snapshot attempt. Cap automatic snapshot attempts at three; after the third stale snapshot, stop without importing.

- [ ] **Step 4: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-storage.test.ts
git add scripts/task-clone/storage.mjs tests/unit/task-clone-storage.test.ts
git diff --cached --check
git commit -m "工具：安全复制 Roadmap 私有图片"
```

---

### Task 5: Transactional Import and Reconciliation

**Files:**
- Modify: `scripts/task-clone/database.mjs`
- Modify: `scripts/task-clone/model.mjs`
- Modify: `tests/unit/task-clone-database.test.ts`
- Modify: `tests/unit/task-clone-model.test.ts`

**Interfaces:**

```js
export function buildImportSql(manifest)
export function buildTargetAuditSql()
export function reconcileSnapshot(manifest, audit, { expectedAuthUsers })
export async function importSnapshot({ query, targetRef, manifest })
```

- [ ] **Step 1: Write failing import tests**

Require import SQL to:

- start a transaction and take a target advisory lock;
- verify the target has no roadmap items, votes, rate-limit rows, image metadata, or image objects before replacement;
- delete only the four migration-seeded projects and reject any other pre-existing project set;
- decode a base64 JSON payload rather than interpolating titles/descriptions as SQL;
- preserve project/item UUIDs and timestamps;
- write each source public vote total to `vote_baseline` while inserting zero target `votes`;
- delete trigger-generated history rows and insert source history ordered by `sourceOrder` without preserving source identity IDs;
- insert image metadata only after object copying succeeds;
- rely on the existing metadata trigger to rebuild logical storage usage;
- assert excluded tables remain empty before commit and roll back on any mismatch.

- [ ] **Step 2: Write failing reconciliation tests**

Compare source and target by stable UUID/path keys. Cover every copied field, each public vote total, history tuple multiplicity, image hashes, total bytes, and target logical usage. Reconciliation must also require zero rows in all excluded operational tables. Pass `expectedAuthUsers: 0` immediately after copying and `expectedAuthUsers: [{ email: "roadmap-admin@internal.invalid" }]` after admin provisioning.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
```

- [ ] **Step 4: Implement target import and audit**

Pass the manifest as base64 in a temporary SQL file:

```sql
select convert_from(decode($snapshot$BASE64_PAYLOAD$snapshot$, 'base64'), 'UTF8')::jsonb;
```

Use `jsonb_to_recordset` with explicit column types. Insert projects, insert items, remove automatically generated history, restore history, then insert image metadata. Audit SQL returns normalized JSON for the copied tables, public vote totals, excluded-table counts, the singleton logical usage value, private bucket settings, and migration version. Object hashes are audited separately by downloading target objects and comparing them with the hydrated manifest.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
git add scripts/task-clone/model.mjs scripts/task-clone/database.mjs tests/unit/task-clone-model.test.ts tests/unit/task-clone-database.test.ts
git diff --cached --check
git commit -m "工具：导入并核对 Roadmap 快照"
```

---

### Task 6: Provider Provisioning and Idempotent Deployment Orchestration

**Files:**
- Create: `scripts/task-clone/providers.mjs`
- Create: `scripts/task-clone/run.mjs`
- Create: `tests/unit/task-clone-providers.test.ts`
- Create: `tests/unit/task-clone-run.test.ts`

**Interfaces:**

```js
export function createSupabaseProvider({ fetchImpl, runCommand })
export function createCloudflareProvider({ fetchImpl, runCommand })
export async function prepareTarget(context)
export async function copyTarget(context)
export async function deployTarget(context)
```

- [ ] **Step 1: Write failing provider tests**

With injected HTTP/CLI adapters, cover:

- source project lookup must match `.env.deploy.local` and yields its organization and region;
- target creation is `task-roadmap`, same region, Free-plan-compatible `micro` size, with generated DB password;
- an existing project is accepted only when its ref equals `.env.task.deploy.local`;
- API key discovery selects `sb_publishable_` and `sb_secret_` keys and never logs them;
- target Auth configuration sets `site_url = https://task.telljax.com`, disables signup, keeps email/password enabled, and creates one auto-confirmed admin;
- Pages project identity is exactly `task-roadmap-ui` with production branch `master`;
- Production and Preview bindings contain target `SUPABASE_URL`, publishable key, and `secret_text` `SUPABASE_SECRET_KEY`;
- Edge secrets use the target salt and exact origins `https://task.telljax.com,https://task-roadmap-ui.pages.dev`;
- a pre-existing DNS record or foreign custom-domain binding returns `DOMAIN_CONFLICT` without mutation;
- provider errors expose status/request IDs but redact request/response bodies and headers.

Add orchestration tests that require strict stage ordering, at most three stale-snapshot retries, no deployment before reconciliation, no domain mutation before a successful stable-domain smoke, no second copy after a recorded successful copy, cleanup on each failure branch, and idempotent status checks.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts
```

- [ ] **Step 3: Implement `prepare`**

The staged command must:

1. validate the source file without printing values;
2. list Supabase projects and require exactly one source-ref match;
3. generate target-only credentials;
4. create `task-roadmap` in the source region and wait for healthy status with bounded polling;
5. fetch target API keys, write `.env.task.deploy.local` atomically, and revalidate source/target separation;
6. dry-run all migrations against the target ref, then apply them with `supabase db push --linked --project-ref {targetRef} --yes`;
7. audit that the private bucket, size/MIME limits, and empty operational tables are correct.

If target creation succeeds but local file creation fails, report only the target ref and stop; never create a second project on retry.

- [ ] **Step 4: Implement `copy`**

Compose Tasks 3–5 as: capture DB snapshot → download/hash source objects → verify fresh target → import relational rows → upload objects → insert image metadata → database audit → target-object hash audit. If image metadata must be inserted after upload, split import into a relational transaction and a final image-metadata transaction; on the latter's failure, remove only this run's uploaded paths.

The runner prints a table of counts and equality booleans only. On success it removes the temporary directory in `finally`. On failure it preserves a redacted diagnostics JSON containing stage, counts, paths, and provider request IDs, but no record contents or credentials.

- [ ] **Step 5: Implement target admin and runtime deployment**

After reconciliation:

1. patch target Auth configuration and create the confirmed admin via target Auth Admin API;
2. deploy both Edge Functions with `--project-ref {targetRef} --use-api --import-map supabase/functions/deno.json --no-verify-jwt`;
3. set target Edge secrets without changing the linked source project's secrets;
4. create `task-roadmap-ui` if absent;
5. configure Production and Preview runtime bindings through the Cloudflare Pages API;
6. build with target `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and fixed admin email in the child environment;
7. require `out/_routes.json` to route only `/media/*`;
8. deploy `out` to production branch `master` and wait for a successful Pages deployment.

- [ ] **Step 6: Verify and commit**

```powershell
npm run test:run -- tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts
npm run test:run
npm run lint
npm run typecheck
npm run build
git add scripts/task-clone/providers.mjs scripts/task-clone/run.mjs tests/unit/task-clone-providers.test.ts tests/unit/task-clone-run.test.ts
git diff --cached --check
git commit -m "部署：支持 Task Roadmap 独立实例"
```

---

### Task 7: Disposable Production Smoke and Operational Documentation

**Files:**
- Create: `scripts/task-clone/smoke.mjs`
- Create: `tests/unit/task-clone-smoke.test.ts`
- Modify: `docs/deployment.md`

**Interfaces:**
- Tests only `https://task-roadmap-ui.pages.dev` before domain binding and `https://task.telljax.com` after binding.
- Creates uniquely prefixed target fixtures and always removes them in `finally`.

- [ ] **Step 1: Write the failing smoke-orchestration test**

Inject browser and provider adapters. Assert the script refuses a source URL, uses only the target ref, records source counters read-only, creates uniquely tagged fixtures, checks both cache responses and repeated voting, and always invokes target cleanup from `finally` after success or any intermediate failure.

```powershell
npm run test:run -- tests/unit/task-clone-smoke.test.ts
```

Expected: FAIL because `scripts/task-clone/smoke.mjs` does not exist.

- [ ] **Step 2: Implement the target-only smoke script**

Use Playwright for public/admin flows and provider adapters for audit cleanup. Generate a valid small PNG in memory. Record starting target counts and image usage, then verify:

1. the public Roadmap renders the copied projects/items and correct vote totals;
2. a text suggestion and an image suggestion enter `pending` only in the target;
3. the target admin logs in, sees the pending private preview, and approves the image suggestion;
4. the first `/media/{imageId}` response is `MISS`, the second is `HIT`, both have the agreed cache/security headers;
5. the same client IP's first target vote succeeds and the second is rejected;
6. source counts and vote totals captured before smoke remain unchanged;
7. deleting fixtures removes their metadata/object/vote and restores starting target counts and usage.

Never use a customer image or existing item for smoke. If UI cleanup fails, use the target secret only to remove rows/objects carrying the generated smoke prefix and verify exact IDs before deletion.

- [ ] **Step 3: Run the focused smoke test**

```powershell
npm run test:run -- tests/unit/task-clone-smoke.test.ts
```

- [ ] **Step 4: Document the independent instance**

Add a `Task Roadmap` section to `docs/deployment.md` covering:

- target URLs, Pages project, and independent Supabase project;
- `.env.task.deploy.local` recovery and non-commit policy;
- `prepare`, `copy`, `deploy`, `smoke`, and `status` commands;
- copied and excluded datasets;
- historical vote baseline behavior;
- domain preflight and custom-domain binding;
- rollback by removing only `task.telljax.com` from the target Pages project while retaining target Supabase for diagnosis;
- source protection and the absence of continuous synchronization.

- [ ] **Step 5: Run the complete verification matrix**

```powershell
npm run test:run
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npx wrangler pages functions build --outdir .wrangler/functions-build
git diff --check
```

Expected: zero test/lint/type failures, a successful static export and Pages Function bundle, and `out/_routes.json` containing only `/media/*`. Verify no Supabase-labelled local Docker containers, volumes, or networks exist.

- [ ] **Step 6: Request review and resolve findings**

Use `superpowers:requesting-code-review` on the complete implementation. Review specifically for source/target ref confusion, accidental source mutation, manifest IP/secret leakage, SQL injection, target overwrite, compensating image cleanup, bigint precision, Auth signup state, service-key bundling, Cloudflare preview bindings, DNS conflicts, and admin password logging. Apply findings with `superpowers:receiving-code-review`, rerun focused tests, then repeat Step 5.

- [ ] **Step 7: Commit documentation and smoke tooling**

```powershell
git add scripts/task-clone/smoke.mjs tests/unit/task-clone-smoke.test.ts docs/deployment.md
git diff --cached --check
git commit -m "文档：记录 Task Roadmap 独立部署"
```

---

### Task 8: Provision, Copy, Publish, and Hand Off

**Files:**
- Runtime only: `.env.deploy.local`, ignored `.env.task.deploy.local`, provider resources, and generated temporary directories.

- [ ] **Step 1: Verify and push the reviewed code before live provisioning**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Require clean `master`, review only Chinese commits in `origin/master..master`, rerun the verification matrix from `master`, and push without rewriting history.

```powershell
git status --short --branch
git log --oneline origin/master..master
git push origin master
```

- [ ] **Step 2: Prepare the target Supabase project**

```powershell
npm run deploy:task:prepare
npm run deploy:task:check
```

Expected: a healthy new project, all migrations applied, a private empty image bucket, and an ignored target config file. Query source and target refs after preparation and require they differ.

- [ ] **Step 3: Execute the one-time copy and reconciliation**

```powershell
npm run deploy:task:copy
```

Require the eleven reconciliation groups to pass: projects, items, item UUIDs/fields, public vote totals, empty target votes, status history, image metadata, image object hashes, logical usage, empty rate limits, and excluded Auth state before target admin creation. Run `copy` only once after a successful result; later application data diverges by design.

- [ ] **Step 4: Deploy target Auth, Edge Functions, and Pages**

```powershell
npm run deploy:task:deploy
```

Verify the new administrator is the only target Auth user, signup is disabled, Edge origins and salt are target-only, Pages runtime secrets exist in Production and Preview, and the successful deployment commit equals current `master`.

- [ ] **Step 5: Smoke the stable Pages domain**

```powershell
npm run deploy:task:smoke -- --base-url https://task-roadmap-ui.pages.dev
```

Expected: all product, vote, image privacy/cache, admin, cleanup, and source-unchanged assertions pass. Run `deploy:task:status` afterward and require the target to equal the saved post-copy baseline again.

- [ ] **Step 6: Preflight and bind `task.telljax.com`**

Read the exact DNS record set for `task.telljax.com` and list existing Pages custom domains. If any record points elsewhere or another Pages project owns the hostname, stop and report it without mutation. Otherwise run `npm run deploy:task:domain` to create the target Pages custom-domain binding through Cloudflare's API, let Cloudflare create the proxied DNS record, wait for active certificate/domain status, and verify no unrelated DNS record changed.

- [ ] **Step 7: Smoke the final domain and verify repository state**

```powershell
npm run deploy:task:smoke -- --base-url https://task.telljax.com
git status --short --branch
git log -1 --oneline
```

Expected: `https://task.telljax.com/` returns 200, `/admin/` logs in, CSP and `/media/*` cache headers are correct, cleanup restores the copied baseline, and Git shows clean synchronized `master`.

- [ ] **Step 8: Final administrator handoff**

Read `ADMIN_PASSWORD` from `.env.task.deploy.local` without printing it to command output. In the final response, return exactly:

- User URL: `https://task.telljax.com/`
- Admin URL: `https://task.telljax.com/admin/`
- Admin email: `roadmap-admin@internal.invalid`
- Admin password: the generated target password
- Deployment commit and a concise smoke/reconciliation result

Do not repeat the password in logs, documentation, commit messages, or any later status summary.
