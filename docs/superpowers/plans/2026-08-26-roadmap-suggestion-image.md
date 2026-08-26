# Roadmap Suggestion Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one optional, strictly sub-5 MB JPEG or PNG on each public suggestion, keep unapproved images private, show approved images in the existing detail UI, and serve public images through a Cloudflare edge cache.

**Architecture:** Supabase Postgres owns one-to-one image metadata, rolling per-IP upload limits, and an atomic 900 MB logical quota; a private Supabase Storage bucket owns the bytes. The existing `submit-suggestion` Edge Function accepts JSON and multipart requests, validates image signatures and dimensions, then performs compensating cleanup on failure. Public clients receive only a status-gated image UUID and load `/media/{imageId}`; a narrowly routed Cloudflare Pages Function checks edge cache first and reaches Supabase only on a cache miss. Authenticated administrators use short-lived signed Storage URLs for private review.

**Tech Stack:** Next.js 16 static export, React 19, TypeScript 5, Base UI, Tailwind CSS 4, Supabase Postgres/RLS/Storage/Edge Functions, Deno, Zod, Cloudflare Pages Functions Cache API, Vitest, React Testing Library, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-roadmap-suggestion-image-design.md`

## Global Constraints

- Accept zero or one image. Accepted filename extensions are `.jpeg`, `.jpg`, and `.png`; accepted contents are JPEG and PNG only.
- Reject `file.size >= 5_000_000`, empty files, MIME/extension/signature disagreement, width or height above 12,000, and images above 40,000,000 pixels.
- Keep `roadmap-images` private. Never put `storage_path` in `roadmap_items_public`, browser view models, errors, or logs; the dedicated public-status view may return it only for the Cloudflare origin lookup approved in the spec. Never expose signed URLs, IP values, hashes, secret keys, or internal Supabase errors to anonymous clients or logs.
- Show public bytes only while the parent item is `approved`, `in_progress`, or `completed`. A cached URL may remain readable for at most the accepted 24-hour edge TTL after a later status reversal or deletion.
- Enforce three image submissions per HMAC-IP over a rolling 24-hour window. Keep the existing ten text suggestions per hour and consume both limits for a request containing an image.
- Reserve capacity atomically before upload and cap logical image usage at 900,000,000 bytes. Pure-text submissions must remain available when image storage is full.
- Keep the existing UI tokens, Inter typography, dialog sizes, border/shadow language, responsive behavior, and dark mode. Do not add a font, palette, gradient, heavy shadow, or independent animation system.
- Do not recreate the removed local Supabase Docker stack. Run pgTAP against the linked cloud project through the existing IPv4 Session Pooler workflow.
- Do not print or commit `.env.deploy.local`, database URLs, passwords, access tokens, publishable keys, secret keys, signed URLs, or salts.
- Use Chinese commit messages. Push and deploy only after all tests, static checks, production build, security checks, and review pass.

---

## File Map

- Create `supabase/migrations/20260826090000_roadmap_suggestion_images.sql`: bucket, metadata, quota, rolling image rate limit, RLS, Storage policies, and public-safe views.
- Create `supabase/tests/database/suggestion-images.test.sql`: pgTAP schema, visibility, quota, rate-limit, and deletion coverage.
- Create `supabase/functions/_shared/suggestion-image.ts`: multipart parsing, extension/MIME/signature/dimension validation, and stable public errors.
- Create `supabase/functions/_shared/suggestion-upload.ts`: upload orchestration and compensating cleanup with dependency injection.
- Modify `supabase/functions/_shared/validation.ts`: preserve JSON validation and expose normalized text-field parsing.
- Modify `supabase/functions/submit-suggestion/index.ts`: dispatch JSON/multipart requests and adapt Supabase repositories.
- Create `tests/unit/suggestion-image.test.ts`: server image validation tests.
- Create `tests/unit/suggestion-upload.test.ts`: orchestration, quota, and rollback tests.
- Modify `scripts/test-local-functions.mjs`: add a reusable multipart request helper without starting Docker automatically.
- Modify `features/roadmap/types.ts`: optional suggestion file and public image state.
- Modify `features/roadmap/api.ts`: multipart submission and public image mapping.
- Create `features/roadmap/suggestion-image.ts`: browser-side selection validation and file-size formatting.
- Create `components/roadmap/suggestion-image-field.tsx`: visually consistent single-image picker and preview.
- Modify `components/roadmap/suggestion-dialog.tsx`: compose the picker, lifecycle cleanup, and upload state.
- Modify `tests/unit/roadmap-api.test.ts`: FormData and public item mapping tests.
- Create `tests/unit/suggestion-image-field.test.tsx`: picker behavior and object-URL cleanup.
- Modify `tests/unit/suggestion-dialog.test.tsx`: optional file submission and reset coverage.
- Create `components/roadmap/item-image.tsx`: public loading, failure, retry, review notice, and image display states.
- Modify `components/roadmap/item-details.tsx`: place the image in the existing left detail column.
- Modify `tests/unit/item-details.test.tsx`: approved, pending, rejected, no-image, and retry coverage.
- Modify `features/roadmap/admin-api.ts`: hydrate strict image state after direct item mutations.
- Modify `tests/unit/admin-api.test.ts`: cover hydrated direct-mutation results.
- Modify `tests/unit/roadmap-board.test.tsx`: add explicit image fields to typed fixtures.
- Modify `tests/unit/roadmap-timeline.test.ts`: add explicit image fields to typed fixtures.
- Modify `tests/unit/use-roadmap.test.tsx`: add explicit image fields to typed fixtures.
- Modify `features/roadmap/admin-api.ts`: private metadata lookup, signed preview, and storage-first deletion.
- Modify `components/admin/item-dialog.tsx`: signed image review block.
- Modify `tests/unit/admin-api.test.ts`: signed preview and safe deletion tests.
- Create `tests/unit/admin-item-dialog.test.tsx`: loading/failure/retry/non-blocking edit coverage.
- Create `functions/media/[imageId].ts`: UUID-only Cloudflare Pages image cache gateway.
- Create `tests/unit/media-function.test.ts`: cache HIT/MISS, status, origin, and header tests.
- Create `public/_routes.json`: route only `/media/*` through Pages Functions.
- Modify `public/_headers`: permit administrator signed Supabase images in CSP.
- Modify `tests/e2e/public-roadmap.spec.ts`: single-file selection, multipart submit, moderation notice, and public image flow.
- Modify `tests/e2e/admin.spec.ts`: pending image review and storage-first deletion flow.
- Modify `docs/deployment.md`: storage, Cloudflare runtime variables, rollout, smoke test, and rollback.

---

### Task 1: Private Storage, Image Metadata, Quotas, and Safe Views

**Files:**
- Create: `supabase/migrations/20260826090000_roadmap_suggestion_images.sql`
- Create: `supabase/tests/database/suggestion-images.test.sql`

**Interfaces:**
- Consumes: `public.roadmap_items`, `public.is_roadmap_admin()`, `public.roadmap_vote_count(uuid)`, `storage.buckets`, and `storage.objects`.
- Produces: private bucket `roadmap-images`, `roadmap_item_images`, `roadmap_image_storage_usage`, `suggestion_image_rate_limits`, `consume_suggestion_image_quota(text, integer)`, `roadmap_item_images_public`, and extended `roadmap_items_public` fields `has_image` and `image_id`.

- [ ] **Step 1: Write the failing pgTAP contract**

Create a transaction-scoped pgTAP file with fixed UUID fixtures and `rollback`. Assert all of these independently:

```sql
select has_table('public', 'roadmap_item_images', 'image metadata table exists');
select has_table('public', 'roadmap_image_storage_usage', 'image usage table exists');
select has_table('public', 'suggestion_image_rate_limits', 'image rate table exists');
select has_view('public', 'roadmap_item_images_public', 'public-safe image view exists');
select has_function(
  'public',
  'consume_suggestion_image_quota',
  array['text', 'integer'],
  'rolling image quota function exists'
);
select ok(
  (select not public from storage.buckets where id = 'roadmap-images'),
  'roadmap image bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'roadmap-images'),
  5000000::bigint,
  'bucket enforces five-million-byte platform cap'
);
select results_eq(
  $$select unnest(allowed_mime_types) from storage.buckets where id = 'roadmap-images' order by 1$$,
  $$values ('image/jpeg'::text), ('image/png'::text)$$,
  'bucket allows only JPEG and PNG'
);
```

Add fixture behavior assertions that:

- a second metadata row for the same `roadmap_item_id` raises unique violation;
- `size_bytes = 5_000_000`, width `12_001`, height `12_001`, and `width * height > 40_000_000` each fail;
- a `pending` image yields `has_image = true`, `image_id = null`, and no row in `roadmap_item_images_public`;
- changing the item to each of `approved`, `in_progress`, and `completed` yields its image ID and public-view row;
- changing to `rejected` removes the image ID and public-view row without deleting metadata;
- reserving `899_999_999` bytes succeeds, the next two-byte reservation fails, and deleting the first row returns `used_bytes` to zero;
- the first three calls to `consume_suggestion_image_quota('fixed-hash', 3)` return true and the fourth returns false;
- after moving the oldest event to more than 24 hours ago, one additional call returns true;
- deleting the item cascades metadata and returns reserved bytes to the starting value;
- `anon` has no direct `select` privilege on `roadmap_item_images`, usage, rate-limit, or `storage.objects`;
- `authenticated` can select metadata only through the admin RLS predicate and has no insert/update privilege.

- [ ] **Step 2: Run the isolated cloud pgTAP file and verify RED**

Load `.env.deploy.local` into process memory without echoing values, construct the existing IPv4 Session Pooler URL, and run:

```powershell
npx supabase test db supabase/tests/database/suggestion-images.test.sql --db-url $roadmapPoolerUrl
```

Expected: FAIL because the bucket, tables, function, and views do not exist. Do not run `supabase start`.

- [ ] **Step 3: Create the schema and private bucket**

The migration must begin with these immutable limits and tables:

```sql
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'roadmap-images',
  'roadmap-images',
  false,
  5000000,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.roadmap_image_storage_usage (
  singleton boolean primary key default true check (singleton),
  used_bytes bigint not null default 0
    check (used_bytes between 0 and 900000000)
);

insert into public.roadmap_image_storage_usage (singleton, used_bytes)
values (true, 0);

create table public.roadmap_item_images (
  id uuid primary key,
  roadmap_item_id uuid not null unique
    references public.roadmap_items(id) on delete cascade,
  storage_path text not null unique
    check (storage_path ~ '^suggestions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(jpg|png)$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes < 5000000),
  width integer not null check (width between 1 and 12000),
  height integer not null check (height between 1 and 12000),
  created_at timestamptz not null default now(),
  check (width::bigint * height::bigint <= 40000000)
);

create table public.suggestion_image_rate_limits (
  id bigint generated always as identity primary key,
  ip_hash text not null check (length(ip_hash) = 64),
  created_at timestamptz not null default now()
);

create index suggestion_image_rate_limits_hash_time_idx
  on public.suggestion_image_rate_limits (ip_hash, created_at desc);
```

- [ ] **Step 4: Add atomic capacity and rolling quota functions**

Implement a `before insert` capacity trigger that atomically updates the singleton row only when the resulting value is at most 900,000,000. Raise `P0001` with internal message `roadmap_image_storage_full` when no row updates. Implement an `after delete` trigger that subtracts `old.size_bytes` and raises if accounting would go negative.

Implement the quota RPC with this exact observable contract:

```sql
create or replace function public.consume_suggestion_image_quota(
  client_ip_hash text,
  quota_limit integer default 3
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent_count integer;
begin
  if client_ip_hash !~ '^[0-9a-f]{64}$' or quota_limit < 1 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(client_ip_hash, 0));

  delete from public.suggestion_image_rate_limits
  where created_at < now() - interval '48 hours';

  select count(*)::integer
  into recent_count
  from public.suggestion_image_rate_limits
  where ip_hash = client_ip_hash
    and created_at > now() - interval '24 hours';

  if recent_count >= quota_limit then
    return false;
  end if;

  insert into public.suggestion_image_rate_limits (ip_hash)
  values (client_ip_hash);
  return true;
end;
$$;
```

Revoke the trigger functions from all browser roles. Grant `consume_suggestion_image_quota(text, integer)` only to `service_role`.

- [ ] **Step 5: Add RLS, Storage policies, and sanitized public reads**

Enable RLS on all three new public tables. Grant authenticated administrators only `select` on image metadata through `public.is_roadmap_admin()`. Add `select` and `delete` policies on `storage.objects` limited to bucket `roadmap-images` and the same administrator predicate. Service-role writes rely on service-role bypass; do not grant anon bucket access.

Create a `security definer`, stable SQL function returning only public image rows after joining current item status. Revoke its default public execution, grant it to `anon`, `authenticated`, and `service_role`, and expose the same four columns through `roadmap_item_images_public` with `security_invoker = true` and `security_barrier = true`:

```sql
select image.id, image.storage_path, image.mime_type, image.size_bytes
from public.roadmap_item_images image
join public.roadmap_items item on item.id = image.roadmap_item_id
where item.status in ('approved', 'in_progress', 'completed');
```

Create a second security-definer helper for one item that returns:

```sql
select
  exists (
    select 1 from public.roadmap_item_images image
    where image.roadmap_item_id = target_item_id
  ) as has_image,
  (
    select image.id
    from public.roadmap_item_images image
    join public.roadmap_items item on item.id = image.roadmap_item_id
    where image.roadmap_item_id = target_item_id
      and item.status in ('approved', 'in_progress', 'completed')
  ) as image_id;
```

Drop and recreate `roadmap_items_public` with every current column plus `has_image boolean not null` and `image_id uuid null`. Preserve all existing view grants and comments. The public item view must not contain `storage_path`.

- [ ] **Step 6: Verify migration RED/GREEN and cloud invariants**

Run a dry run, apply exactly the new migration, then rerun the isolated test:

```powershell
npx supabase db push --linked --dry-run --password $env:SUPABASE_DB_PASSWORD
npx supabase db push --linked --password $env:SUPABASE_DB_PASSWORD --yes
npx supabase test db supabase/tests/database/suggestion-images.test.sql --db-url $roadmapPoolerUrl
```

Expected: the dry run lists only `20260826090000_roadmap_suggestion_images.sql`; migration succeeds; all pgTAP assertions pass and fixtures roll back. Also query usage versus metadata sum and expect one row where both values are equal.

- [ ] **Step 7: Commit the database contract**

```powershell
git add supabase/migrations/20260826090000_roadmap_suggestion_images.sql supabase/tests/database/suggestion-images.test.sql
git diff --cached --check
git commit -m "功能：建立建议图片存储模型"
```

---

### Task 2: Server-Side Image Validation and Failure-Safe Submission

**Files:**
- Create: `supabase/functions/_shared/suggestion-image.ts`
- Create: `supabase/functions/_shared/suggestion-upload.ts`
- Modify: `supabase/functions/_shared/validation.ts`
- Modify: `supabase/functions/submit-suggestion/index.ts`
- Create: `tests/unit/suggestion-image.test.ts`
- Create: `tests/unit/suggestion-upload.test.ts`
- Modify: `scripts/test-local-functions.mjs`

**Interfaces:**
- Produces `parseSuggestionRequest(request)`, `validateSuggestionImage(file)`, `submitSuggestionWithOptionalImage(input, repository)`, and stable errors for size, format, dimensions, rate, and capacity.
- Preserves the existing JSON `{ projectId, title, description }` request and `201 { itemId }` response.

- [ ] **Step 1: Write failing binary validation tests**

Use generated in-memory fixtures; do not commit user images. Cover valid PNG IHDR and JPEG SOF dimensions, `.jpg`/`.jpeg` aliases, exact 5,000,000 bytes, empty file, mismatched extension, mismatched MIME, forged signatures, missing JPEG SOF, 12,001-pixel edge, and above-40MP area.

```ts
expect(await validateSuggestionImage(validPngFile(640, 480))).toMatchObject({
  extension: "png",
  mimeType: "image/png",
  width: 640,
  height: 480,
})

await expect(
  validateSuggestionImage(new File([new Uint8Array(5_000_000)], "proof.png", {
    type: "image/png",
  })),
).rejects.toThrow("图片必须严格小于 5MB")

await expect(
  validateSuggestionImage(validPngFile(8_000, 5_001)),
).rejects.toThrow("图片像素不能超过 4000 万")
```

- [ ] **Step 2: Write failing orchestration tests**

Define this dependency boundary in `suggestion-upload.ts`:

```ts
export interface SuggestionImageRepository {
  createItem(input: NormalizedSuggestion): Promise<string>
  consumeImageQuota(ipHash: string): Promise<boolean>
  createImageMetadata(input: ImageMetadataInput): Promise<void>
  uploadImage(path: string, bytes: Uint8Array, mimeType: string): Promise<void>
  removeImage(path: string): Promise<void>
  removeItem(itemId: string): Promise<void>
}
```

Tests must prove:

- pure text calls only `createItem`;
- an image consumes image quota before `createItem`;
- the generated path is `suggestions/{itemId}/{imageId}.jpg` or `.png` and never contains the original filename;
- metadata is created before Storage upload;
- quota denial returns `当前网络过去 24 小时图片提交次数已达上限`;
- capacity error returns `图片存储空间已满，可移除图片后继续提交文字建议`;
- metadata failure removes the item;
- upload failure attempts object removal and then item removal;
- cleanup failure is not returned verbatim and does not replace the stable public upload error.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/suggestion-image.test.ts tests/unit/suggestion-upload.test.ts
```

Expected: FAIL because the validator and orchestration module do not exist.

- [ ] **Step 4: Implement request parsing and binary validation**

`parseSuggestionRequest` must branch on the normalized media type:

```ts
export interface ParsedSuggestionRequest {
  projectId: string
  title: string
  description: string
  image: File | null
}

export async function parseSuggestionRequest(
  request: Request,
): Promise<ParsedSuggestionRequest>
```

- For `application/json`, run the existing Zod schema and return `image: null`.
- For `multipart/form-data`, call `request.formData()`, require string values for the three text fields, accept only a real non-empty `File` in `image`, and reject repeated/unknown file fields.
- Reject all other content types with `请求格式不受支持`.

`validateSuggestionImage` must read bytes once, compare lowercase extension and browser MIME, verify the complete 8-byte PNG signature and IHDR, or walk JPEG markers until a supported SOF marker is found. Skip standalone markers and reject truncated lengths. Return only this normalized value:

```ts
export interface ValidatedSuggestionImage {
  bytes: Uint8Array
  extension: "jpg" | "png"
  mimeType: "image/jpeg" | "image/png"
  sizeBytes: number
  width: number
  height: number
}
```

Normalize `.jpeg` to stored extension `jpg`. Validate `sizeBytes > 0 && sizeBytes < 5_000_000`, each edge `<= 12_000`, and `width * height <= 40_000_000` before returning.

- [ ] **Step 5: Implement compensating upload orchestration**

Generate the image UUID before metadata insert with `crypto.randomUUID()`. Once `createItem` succeeds, wrap metadata/upload work in `try/catch`. Track whether an object upload was attempted. On any failure, attempt `removeImage(storagePath)` when a path exists, then always attempt `removeItem(itemId)`. Use `Promise.allSettled` only for cleanup; rethrow the mapped public error after cleanup finishes.

The image quota hash must be produced from the request IP with context string `suggestion-image:${VOTE_IP_SALT}` using the existing HMAC helper. Text quota remains on its existing namespace and is consumed first.

- [ ] **Step 6: Adapt the Edge Function without weakening existing checks**

In `submit-suggestion/index.ts`, preserve exact-Origin allowlisting, CORS behavior, publishable-key validation, project existence, IP normalization, and text quota. Replace direct JSON parsing with `parseSuggestionRequest`, then adapt `SuggestionImageRepository` to:

- insert the item with `status: "pending"`;
- call RPC `consume_suggestion_image_quota` with limit `3`;
- insert all normalized metadata columns;
- upload to `roadmap-images` with `{ contentType, upsert: false, cacheControl: "0" }`;
- remove the object through Storage;
- remove the item through `roadmap_items`, allowing cascade and capacity release.

Keep success exactly `201 { itemId }`. Map malformed input to `400`, text/image rate limits to `429`, image capacity to `507`, and unexpected upload failures to `502`; every failure body has only `{ message }`.

- [ ] **Step 7: Extend the black-box helper without recreating local Docker**

Add a multipart helper to `scripts/test-local-functions.mjs` that uses native `FormData` and `File`, and add opt-in assertions for valid PNG and exact-size rejection. The script must continue to require an already available test endpoint and must not run `supabase start`, create containers, or mutate production unless an explicit test base URL is supplied.

- [ ] **Step 8: Run focused and existing function tests**

```powershell
npm run test:run -- tests/unit/function-validation.test.ts tests/unit/suggestion-image.test.ts tests/unit/suggestion-upload.test.ts
```

Expected: all focused suites pass, including the old JSON path.

- [ ] **Step 9: Commit the Edge Function feature**

```powershell
git add supabase/functions/_shared/suggestion-image.ts supabase/functions/_shared/suggestion-upload.ts supabase/functions/_shared/validation.ts supabase/functions/submit-suggestion/index.ts tests/unit/suggestion-image.test.ts tests/unit/suggestion-upload.test.ts scripts/test-local-functions.mjs
git diff --cached --check
git commit -m "功能：安全接收建议图片"
```

---

### Task 3: Public Single-Image Picker and Multipart Client

**Files:**
- Modify: `features/roadmap/types.ts`
- Modify: `features/roadmap/api.ts`
- Create: `features/roadmap/suggestion-image.ts`
- Create: `components/roadmap/suggestion-image-field.tsx`
- Modify: `components/roadmap/suggestion-dialog.tsx`
- Modify: `tests/unit/roadmap-api.test.ts`
- Create: `tests/unit/suggestion-image-field.test.tsx`
- Modify: `tests/unit/suggestion-dialog.test.tsx`

**Interfaces:**
- `SuggestionInput` adds `image: File | null`.
- `submitSuggestion(input)` sends browser-generated multipart data without setting `Content-Type`.
- `SuggestionImageField` owns accessible select/replace/remove UI while its parent owns the selected `File`.

- [ ] **Step 1: Write failing browser validation and picker tests**

Inject a dimension reader into `validateSelectedSuggestionImage` so unit tests remain deterministic:

```ts
export type ReadImageDimensions = (
  file: File,
) => Promise<{ width: number; height: number }>

export async function validateSelectedSuggestionImage(
  file: File,
  readDimensions?: ReadImageDimensions,
): Promise<void>
```

Test valid JPEG and PNG, exact-size rejection, disallowed extension, mismatched MIME, single-file enforcement, dimension errors, filename/size display, remove, replace, `role="alert"`, and `URL.revokeObjectURL` on replace/remove/unmount.

- [ ] **Step 2: Write failing API and dialog tests**

Assert `submitSuggestion` sends a `FormData` body with exact fields and no explicit `Content-Type` header:

```ts
expect(fetch).toHaveBeenCalledWith(
  "https://example.supabase.co/functions/v1/submit-suggestion",
  expect.objectContaining({
    method: "POST",
    headers: { apikey: "public-key" },
    body: expect.any(FormData),
  }),
)
```

Assert the dialog submits the selected `File`, displays `正在上传…`, disables all form controls while pending, clears the image and object URL only after success, preserves all fields after failure, and submits `image: null` when no file is chosen.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/suggestion-image-field.test.tsx tests/unit/suggestion-dialog.test.tsx
```

Expected: FAIL because image types, multipart submission, and picker UI do not exist.

- [ ] **Step 4: Implement client validation and FormData submission**

Use `createImageBitmap(file)` as the default dimension reader and always close the bitmap in `finally`. Reapply the exact extension, MIME, byte, edge, and pixel rules in the browser; the Edge Function remains authoritative.

Change only suggestion submission to multipart. Keep vote requests JSON:

```ts
const formData = new FormData()
formData.set("projectId", input.projectId)
formData.set("title", input.title)
formData.set("description", input.description)
if (input.image) formData.set("image", input.image, input.image.name)

await fetch(`${url}/functions/v1/submit-suggestion`, {
  method: "POST",
  headers: { apikey: publishableKey },
  body: formData,
})
```

- [ ] **Step 5: Build the visually consistent picker**

Use the approved structure:

- `Label` text `附加图片（可选）`;
- container classes `rounded-lg border border-dashed border-input bg-muted/30`;
- `ImagePlus`, an existing `Button variant="outline"`, and help text `仅支持 JPEG、PNG，严格小于 5MB`;
- after selection, an object-contain thumbnail, filename, formatted byte size, and a `ghost` remove button;
- file input `accept=".jpeg,.jpg,.png,image/jpeg,image/png"`, without `multiple`;
- no new color literals beyond existing semantic tokens.

Give the dialog `max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg`. Disable project/title/description/file actions and submit while pending. Release every created object URL on replace, remove, success, close-after-reset, and unmount.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/suggestion-image-field.test.tsx tests/unit/suggestion-dialog.test.tsx
```

Expected: all focused suites pass without React act warnings or leaked object URLs.

- [ ] **Step 7: Commit the public upload UI**

```powershell
git add features/roadmap/types.ts features/roadmap/api.ts features/roadmap/suggestion-image.ts components/roadmap/suggestion-image-field.tsx components/roadmap/suggestion-dialog.tsx tests/unit/roadmap-api.test.ts tests/unit/suggestion-image-field.test.tsx tests/unit/suggestion-dialog.test.tsx
git diff --cached --check
git commit -m "功能：建议表单支持单图上传"
```

---

### Task 4: Status-Gated Public Image in the Detail Dialog

**Files:**
- Modify: `features/roadmap/types.ts`
- Modify: `features/roadmap/api.ts`
- Modify: `features/roadmap/admin-api.ts`
- Create: `components/roadmap/item-image.tsx`
- Modify: `components/roadmap/item-details.tsx`
- Modify: `tests/unit/roadmap-api.test.ts`
- Modify: `tests/unit/admin-api.test.ts`
- Modify: `tests/unit/item-details.test.tsx`
- Modify: `tests/unit/roadmap-board.test.tsx`
- Modify: `tests/unit/roadmap-timeline.test.ts`
- Modify: `tests/unit/use-roadmap.test.tsx`

**Interfaces:**
- `RoadmapItem` adds `hasImage: boolean` and `imageId: string | null`.
- `ItemImage` accepts `{ item, retryKey, onRetry }` or owns an equivalent local retry counter; it never receives a Storage path.
- Public bytes are requested only from `/media/${item.imageId}`.

- [ ] **Step 1: Write failing mapping and detail-state tests**

Extend fixtures and assert exact row mapping:

```ts
expect(mapRoadmapItemRow({
  id: itemId,
  project_id: projectId,
  title: "告警截图",
  description: "复现信息",
  status: "pending",
  sort_order: 0,
  vote_count: 0,
  has_image: true,
  image_id: null,
  created_at: now,
  updated_at: now,
})).toMatchObject({ hasImage: true, imageId: null })
```

Component tests must prove:

- `hasImage = false` renders no image region;
- `pending + hasImage` shows `图片正在审核，通过后将在此显示` and has no `/media/` image;
- `rejected + hasImage` shows `图片未通过审核，不对外显示` and has no `/media/` image;
- approved/in-progress/completed with `imageId` render a lazy image from `/media/{uuid}`;
- loading shows the existing `Skeleton`;
- an image error preserves description, vote, and timeline and shows outline `重新加载`;
- retry remounts the `<img>` with the same canonical URL and a new React key, without adding query parameters.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/item-details.test.tsx
```

Expected: FAIL because public image fields and rendering do not exist.

- [ ] **Step 3: Extend the public query and strict mapper**

Select `has_image,image_id` from `roadmap_items_public`. Reject non-boolean `has_image`; reject a non-null non-UUID `image_id`; reject a non-null image ID when status is `pending` or `rejected`.

After `createRoadmapItem` or `updateRoadmapItem` mutates the base table, query the authenticated metadata table by item ID and hydrate the returned admin item with `hasImage` and the status-gated `imageId`; do not default an existing image to false. The Task 5 preview function will reuse this internal metadata lookup. Update every typed `RoadmapItem` fixture in the listed unit files to specify both new fields.

- [ ] **Step 4: Implement the reusable public image state**

Place the component above `详细说明` in the left detail column. Use `rounded-lg border bg-muted/30`, `loading="lazy"`, `alt={`${item.title} 的建议图片`}`, `object-contain`, and a bounded height that fits the current modal. Use the existing `Skeleton`, destructive text token, and outline button. Do not hide or move the current vote controls, timeline, or disclaimer.

- [ ] **Step 5: Run related tests and verify GREEN**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/item-details.test.tsx tests/unit/roadmap-board.test.tsx tests/unit/use-roadmap.test.tsx
```

Expected: all related tests pass.

- [ ] **Step 6: Commit the public detail display**

```powershell
git add features/roadmap/types.ts features/roadmap/api.ts features/roadmap/admin-api.ts components/roadmap/item-image.tsx components/roadmap/item-details.tsx tests/unit/roadmap-api.test.ts tests/unit/admin-api.test.ts tests/unit/item-details.test.tsx tests/unit/roadmap-board.test.tsx tests/unit/roadmap-timeline.test.ts tests/unit/use-roadmap.test.tsx
git diff --cached --check
git commit -m "功能：详情弹窗展示审核图片"
```

---

### Task 5: Administrator Private Preview and Storage-First Deletion

**Files:**
- Modify: `features/roadmap/admin-api.ts`
- Modify: `components/admin/item-dialog.tsx`
- Modify: `tests/unit/admin-api.test.ts`
- Create: `tests/unit/admin-item-dialog.test.tsx`

**Interfaces:**
- Produces `getAdminRoadmapItemImage(itemId): Promise<AdminRoadmapImage | null>` where the result contains only `id`, `signedUrl`, `mimeType`, `sizeBytes`, `width`, and `height`.
- Changes `deleteRoadmapItem(id)` to delete a private object before deleting the item row.

- [ ] **Step 1: Write failing admin API tests**

Mock Supabase fluent calls and assert:

- no metadata row returns `null` and does not call `createSignedUrl`;
- metadata returns a 300-second signed URL from bucket `roadmap-images`;
- signed URL errors map to `建议图片加载失败，请重试` without exposing paths;
- an item without image deletes directly;
- an item with image calls `storage.remove([storage_path])` before the item delete;
- Storage not-found is treated as already removed and permits item deletion;
- any other Storage failure throws `建议图片删除失败，Roadmap 条目已保留` and never calls item delete.

- [ ] **Step 2: Write failing admin dialog tests**

Tests must cover image skeleton, signed preview, error plus retry, absence of upload/replace/delete-image controls, and continued title/status editing while preview loading or failed. Verify object-contain layout and accessible alt text `待审核建议图片：{title}`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/admin-api.test.ts tests/unit/admin-item-dialog.test.tsx
```

Expected: FAIL because the preview API, safe deletion, and image region do not exist.

- [ ] **Step 4: Implement private metadata and signed preview**

Query `roadmap_item_images` by `roadmap_item_id`, then create a signed URL with:

```ts
getSupabaseBrowserClient()
  .storage
  .from("roadmap-images")
  .createSignedUrl(storagePath, 300)
```

Never return `storagePath` from the exported preview function. The internal deletion helper may retain it only inside `admin-api.ts`.

- [ ] **Step 5: Implement storage-first deletion**

Load metadata first. When it exists, await Storage removal and classify only an explicit object-not-found response as safe. Await row deletion only afterward. This order ensures metadata and quota stay reserved if Storage deletion fails. Preserve existing project foreign-key error behavior.

- [ ] **Step 6: Add the review block without blocking form edits**

Load the preview only for an existing item and guard against stale results when the dialog switches items or closes. Render `建议图片` with the same `rounded-lg border bg-muted/30`, Skeleton, failure copy, and outline retry language as public details. Do not add admin image mutation controls.

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
npm run test:run -- tests/unit/admin-api.test.ts tests/unit/admin-item-dialog.test.tsx
```

Expected: all focused suites pass.

- [ ] **Step 8: Commit the admin review flow**

```powershell
git add features/roadmap/admin-api.ts components/admin/item-dialog.tsx tests/unit/admin-api.test.ts tests/unit/admin-item-dialog.test.tsx
git diff --cached --check
git commit -m "功能：管理端审核并安全删除建议图片"
```

---

### Task 6: Cloudflare `/media/*` Cache Gateway and Route Isolation

**Files:**
- Create: `functions/media/[imageId].ts`
- Create: `tests/unit/media-function.test.ts`
- Create: `public/_routes.json`
- Modify: `public/_headers`

**Interfaces:**
- Runtime environment: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and secret `SUPABASE_SECRET_KEY`.
- Produces `onRequest(context)` and exported `handleMediaRequest(context, dependencies)` for unit testing.
- Only `/media/*` invokes Pages Functions.

- [ ] **Step 1: Write failing cache-gateway tests**

Use dependency injection rather than real network calls:

```ts
export interface MediaDependencies {
  cacheMatch(request: Request): Promise<Response | undefined>
  cachePut(request: Request, response: Response): Promise<void>
  lookupPublicImage(id: string, env: MediaEnv): Promise<PublicImageRecord | null>
  downloadPrivateImage(path: string, env: MediaEnv): Promise<Response>
}
```

Test all contracts independently:

- POST returns 405 with `Allow: GET` and `no-store`;
- malformed UUID returns 400 and does not touch cache or Supabase;
- missing runtime values return 503 and `no-store`;
- cache HIT returns bytes and `X-Roadmap-Cache: HIT`, with zero lookup/download calls;
- cache MISS with no public row returns 404 and is not cached;
- valid MISS downloads once, stores once, returns `MISS`, and stores a response without a fixed HIT/MISS header;
- MIME disagreement, non-200 origin, and absent, invalid, oversized, or metadata-mismatched content length return `502` with `no-store`;
- canonical cache key removes query parameters;
- successful responses include `public, max-age=3600, s-maxage=86400`, `nosniff`, and `inline`.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm run test:run -- tests/unit/media-function.test.ts
```

Expected: FAIL because the Pages Function does not exist.

- [ ] **Step 3: Implement cache-first request handling**

Define local structural context types so the existing browser TypeScript configuration is not replaced by global Workers types. Validate `imageId` with the canonical UUID regex. Reject unexpected query parameters, but construct the cache key from `new URL(request.url).origin + pathname`.

The production dependencies must be created lazily after cache MISS. Query:

```text
/rest/v1/roadmap_item_images_public?id=eq.{uuid}&select=id,storage_path,mime_type,size_bytes&limit=1
```

with the publishable key. Fetch the private Storage object using the secret key only inside the Function runtime. Percent-encode each path segment independently. Before caching, require metadata size `< 5_000_000`, upstream type equality, and a finite safe `Content-Length` that equals metadata size and is below 5,000,000. Forward the verified response stream instead of buffering the image a second time. Return generic Chinese errors only; never include origin response text.

Clone cached responses so each client receives a fresh `X-Roadmap-Cache` value. Use `context.waitUntil(cachePut(...))`; a cache-write failure must not fail a valid image response.

- [ ] **Step 4: Restrict Pages Function routing**

Create exactly:

```json
{
  "version": 1,
  "include": ["/media/*"],
  "exclude": []
}
```

Update CSP `img-src` from `img-src 'self' data: blob:` to `img-src 'self' data: blob: https://*.supabase.co`. Do not broaden `connect-src`, script policy, frame policy, or any other header.

- [ ] **Step 5: Run focused tests and build the Pages Function**

```powershell
npm run test:run -- tests/unit/media-function.test.ts
npx wrangler pages functions build --outdir .wrangler/functions-build
```

Expected: unit tests pass; Wrangler discovers `functions/media/[imageId].ts` and produces a valid bundle. Remove only the verified `.wrangler/functions-build` generated directory if it is untracked and scoped inside this repository.

- [ ] **Step 6: Commit the cache gateway**

```powershell
git add functions/media/[imageId].ts tests/unit/media-function.test.ts public/_routes.json public/_headers
git diff --cached --check
git commit -m "功能：Cloudflare 缓存公开建议图片"
```

---

### Task 7: Browser Contracts, Documentation, Review, and Production Rollout

**Files:**
- Modify: `tests/e2e/public-roadmap.spec.ts`
- Modify: `tests/e2e/admin.spec.ts`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: completed database, Edge Function, UI, Pages Function, `.env.deploy.local`, linked Supabase project, Cloudflare Pages project `roadmap-ui`, `telljax.com`, and `admin.telljax.com`.
- Produces: reviewed Chinese commits, clean `master`, deployed cloud resources, and live cache verification.

- [ ] **Step 1: Add failing public browser coverage**

Update mocked item rows to include `has_image` and `image_id`. Replace `postDataJSON()` in the suggestion route with assertions on `multipart/form-data` content and preserve extraction of project/title/description. Use Playwright `setInputFiles` with an in-memory valid PNG under 5 MB.

Add a workflow that verifies selection preview, filename, removal, selection again, `正在上传…`, successful pending card, and pending moderation notice without a `/media/` request. Then update the fixture to `approved` with an image UUID, fulfill `/media/{uuid}` with a PNG, reopen details, and verify image visibility. Abort `/media/` once, click `重新加载`, then fulfill it and verify the description, voting control, and timeline never disappear.

- [ ] **Step 2: Add failing administrator browser coverage**

Mock metadata lookup, `storage/v1/object/sign`, the signed image URL, and Storage DELETE. Verify a pending item shows the signed preview, still permits status change, and deletion sends Storage DELETE before PostgREST item DELETE. Add a separate Storage failure branch that preserves the item and displays `建议图片删除失败，Roadmap 条目已保留`.

- [ ] **Step 3: Run both E2E files and verify RED, then GREEN**

```powershell
npm run test:e2e -- tests/e2e/public-roadmap.spec.ts tests/e2e/admin.spec.ts
```

Expected first run before fixture/harness completion: FAIL on multipart or image assertions. Expected final run: both workflows pass at desktop and 390 px without horizontal dialog overflow.

- [ ] **Step 4: Document setup, rollout, and rollback**

Update `docs/deployment.md` with:

- private bucket name, strict application limits, rolling image limit, and 900 MB logical cap;
- Cloudflare Production and Preview runtime variables `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and encrypted `SUPABASE_SECRET_KEY`;
- warning that `SUPABASE_SECRET_KEY` is server-only and must never use `NEXT_PUBLIC_`;
- `_routes.json` isolation so only `/media/*` consumes Pages Function requests;
- ordered database → Edge Function → Cloudflare runtime → Pages deployment;
- smoke checks for pending privacy, admin signed preview, approved public image, cache MISS/HIT, delete cleanup, and usage restoration;
- rollback boundary: Pages rollback and prior Edge Function code are safe because JSON remains supported; the additive database migration remains in place.

- [ ] **Step 5: Run the complete local verification matrix**

```powershell
npm run test:run
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npx wrangler pages functions build --outdir .wrangler/functions-build
git diff --check
```

Expected: zero unit/E2E failures, zero lint/type errors, successful static export, successful Function bundle, and no whitespace errors. Confirm `out/_routes.json` exists and contains only `/media/*`.

- [ ] **Step 6: Run database and security verification**

Using secret values only in process memory:

```powershell
npx supabase db push --linked --dry-run --password $env:SUPABASE_DB_PASSWORD
npx supabase test db supabase/tests/database/suggestion-images.test.sql --db-url $roadmapPoolerUrl
```

Expected: no pending migrations and all pgTAP assertions pass. Also verify anonymous requests cannot read `roadmap_item_images`, `storage.objects`, or a pending row through `roadmap_item_images_public`.

- [ ] **Step 7: Verify local Supabase Docker cleanup remains intact**

```powershell
docker container ls --all --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.ID}}'
docker volume ls --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.Name}}'
docker network ls --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.ID}}'
```

Expected: all three commands return no resources.

- [ ] **Step 8: Request code review and resolve findings**

Use `superpowers:requesting-code-review` against the full feature diff. Review specifically for private-path leakage, service-key bundling, cache HIT origin access, RLS bypass scope, byte-limit off-by-one behavior, cleanup ordering, object-URL leaks, visual consistency, and regressions to pure-text suggestions. Apply findings with `superpowers:receiving-code-review`, rerun every affected focused test, then rerun Step 5.

- [ ] **Step 9: Commit documentation and verified test contracts**

```powershell
git add tests/e2e/public-roadmap.spec.ts tests/e2e/admin.spec.ts docs/deployment.md
git diff --cached --check
git commit -m "测试：覆盖建议图片审核与缓存"
```

If review required implementation changes, commit them separately with a precise Chinese message before this documentation/test commit. Do not amend already reviewed commits.

- [ ] **Step 10: Merge the feature branch and push a clean master**

Use `superpowers:finishing-a-development-branch`. Verify the feature worktree is clean, merge into local `master` without rewriting user commits, rerun the verification matrix from the merged tree, then:

```powershell
git status --short --branch
git log --oneline origin/master..master
git push origin master
```

Expected before push: only reviewed Chinese feature commits are ahead and the working tree is clean. Expected after push: `master...origin/master` with no divergence.

- [ ] **Step 11: Deploy the compatible Edge Function**

Load Supabase values without printing them and run:

```powershell
npx supabase functions deploy submit-suggestion --use-api --import-map supabase/functions/deno.json --no-verify-jwt --yes
```

Expected: deployment succeeds and the function still accepts an authenticated-origin JSON pure-text smoke request.

- [ ] **Step 12: Configure Cloudflare runtime values and deploy Pages**

Before deployment, verify Production and Preview both have runtime `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and encrypted `SUPABASE_SECRET_KEY`. Set values from `.env.deploy.local` through Wrangler or Cloudflare's API without writing them to command history or output. Then build with public values and deploy:

```powershell
npm run build
npx wrangler pages deploy out --project-name=roadmap-ui --branch=master
```

Expected: deployment status is `success`, root static routes remain static, and `/media/*` is the only Function route.

- [ ] **Step 13: Run controlled production smoke tests and clean up**

Create one small generated PNG suggestion and one text-only suggestion through `https://telljax.com`. Verify:

1. pending item returns `has_image = true` and `image_id = null`;
2. guessed/direct Storage URLs do not expose the private object;
3. `https://admin.telljax.com` redirects to `/admin/`, logs in, and shows the signed pending preview;
4. approval causes a fresh public query to return `image_id`;
5. first `/media/{imageId}` response is `MISS`, second is `HIT`, both have the agreed cache and security headers;
6. the HIT request produces no new Supabase image-view or Storage read in available logs;
7. deleting the test item deletes its Storage object and restores usage;
8. the text-only suggestion can be deleted without any Storage request.

Do not use a real customer screenshot. Delete every smoke-test item and object through the product flow; confirm metadata count and logical usage return to their pre-test values.

- [ ] **Step 14: Final repository and production verification**

```powershell
git status --short --branch
git log -1 --oneline
```

Expected: clean `master...origin/master`. Record only the production deployment ID, commit hash, Pages URL, domain status, and non-secret smoke outcomes.
