# Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a serverless public Roadmap with project switching, anonymous suggestions, one vote per public IP, and a password-protected admin workspace.

**Architecture:** Export the existing Next.js App Router project as static assets for Cloudflare Pages. Browser reads and authenticated admin mutations use Supabase with RLS; anonymous suggestions and votes go through Supabase Edge Functions, with the vote function hashing Cloudflare's trusted client IP before insert.

**Tech Stack:** Next.js 16.2.6, React 19.2.4, TypeScript 5, Tailwind CSS 4, shadcn/ui, Supabase Postgres/Auth/Edge Functions, Vitest, React Testing Library, Playwright, pgTAP, Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-08-24-roadmap-design.md`

## Global Constraints

- Keep the existing Inter, blue token palette, rounded controls, and shadcn/ui component system.
- Static export only: no Next.js cookies, Server Actions, dynamic Route Handlers, request-time headers, or default image optimization.
- Public users do not authenticate; Supabase Auth has one manually created admin and public signup is disabled.
- The admin screen displays only a password field; the fixed login email is a public build variable, not a secret.
- Never commit the admin password, Supabase secret/service-role keys, database password, or `VOTE_IP_SALT`.
- Suggestions always enter `pending`; statuses are exactly `pending`, `approved`, `in_progress`, `completed`, `rejected`.
- The vote function trusts only the platform-provided `cf-connecting-ip`, stores only an HMAC-SHA-256 hash, and relies on a database unique constraint for concurrency safety.
- On-screen content must be real product copy or explicit empty states; do not seed fake Roadmap items.
- Every implementation task follows red-green-refactor and ends with a focused commit.

---

## File Map

- `app/page.tsx`: public route shell.
- `app/admin/page.tsx`: admin route shell.
- `app/admin/layout.tsx`: admin metadata with search indexing disabled.
- `app/layout.tsx`, `app/globals.css`: global metadata, fonts, product tokens, responsive board styles.
- `components/roadmap/*`: public board, project switcher, item details, suggestion form, vote control.
- `components/admin/*`: login gate, project manager, item editor, admin board.
- `components/ui/*`: generated shadcn primitives only.
- `features/roadmap/types.ts`: shared domain types and status metadata.
- `features/roadmap/api.ts`: public Supabase reads and Edge Function calls.
- `features/roadmap/admin-api.ts`: authenticated admin CRUD.
- `features/roadmap/use-roadmap.ts`: public data loading and optimistic refresh state.
- `features/admin/use-admin-session.ts`: Supabase Auth session boundary.
- `lib/supabase/browser.ts`: singleton browser Supabase client.
- `supabase/migrations/20260824000000_roadmap.sql`: schema, seed projects, view, grants, triggers, RLS.
- `supabase/functions/_shared/*`: CORS, response, validation, IP normalization and HMAC helpers.
- `supabase/functions/submit-suggestion/index.ts`: anonymous suggestion endpoint.
- `supabase/functions/vote/index.ts`: anonymous IP-constrained vote endpoint.
- `supabase/tests/database/roadmap.test.sql`: pgTAP schema/RLS/constraint assertions.
- `tests/unit/*`: Vitest domain, hook and component tests.
- `tests/e2e/*`: Playwright public/admin flows with deterministic API fixtures.
- `.env.example`: public variable names with non-secret example values.
- `public/_headers`: Cloudflare security headers.
- `scripts/generate-admin-password.mjs`: prints a strong password without persisting it.
- `docs/deployment.md`: Supabase, Cloudflare Pages, custom domain and DNS runbook.

---

### Task 1: Static-export and test foundation

**Files:**
- Modify: `package.json`
- Modify: `next.config.ts`
- Create: `vitest.config.mts`
- Create: `tests/setup.ts`
- Create: `.env.example`
- Test: `tests/unit/environment.test.ts`

**Interfaces:**
- Produces: `npm run test`, `npm run test:run`, `npm run test:e2e`, and a static `out/` build.
- Produces: build variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_ADMIN_EMAIL`.

- [ ] **Step 1: Add the failing environment contract test**

```ts
import { describe, expect, it } from "vitest"

describe("public environment contract", () => {
  it("documents every browser-side variable", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(".env.example", "utf8"),
    )
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_URL=")
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=")
    expect(source).toContain("NEXT_PUBLIC_ADMIN_EMAIL=")
    expect(source).not.toContain("SERVICE_ROLE")
  })
})
```

- [ ] **Step 2: Run the test to verify the missing test stack/config fails**

Run: `npm run test:run -- tests/unit/environment.test.ts`

Expected: FAIL because Vitest and the scripts/configuration do not exist.

- [ ] **Step 3: Install runtime and test dependencies**

Run:

```powershell
npm install @supabase/supabase-js zod @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom @testing-library/user-event vite-tsconfig-paths @playwright/test supabase
npx shadcn@latest add badge card dialog dropdown-menu input label select separator sheet skeleton textarea alert-dialog
```

- [ ] **Step 4: Add scripts and configuration**

Add these scripts to `package.json`:

```json
{
  "test": "vitest",
  "test:run": "vitest run",
  "test:e2e": "playwright test",
  "supabase:test": "supabase test db"
}
```

Create `vitest.config.mts`:

```ts
import react from "@vitejs/plugin-react"
import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
  },
})
```

Create `tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest"
```

Set static output in `next.config.ts`:

```ts
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
}

export default nextConfig
```

Create `.env.example` with non-secret examples:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_00000000000000000000000000000000
NEXT_PUBLIC_ADMIN_EMAIL=roadmap-admin@internal.invalid
```

- [ ] **Step 5: Verify the foundation**

Run: `npm run test:run -- tests/unit/environment.test.ts && npm run typecheck && npm run build`

Expected: test PASS, typecheck PASS, `out/index.html` and `out/admin/index.html` will exist after the admin route is added in Task 6; at this task `out/index.html` exists.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json next.config.ts vitest.config.mts tests/setup.ts tests/unit/environment.test.ts .env.example components/ui
git commit -m "chore: configure static build and tests"
```

---

### Task 2: Domain model and Supabase browser client

**Files:**
- Create: `features/roadmap/types.ts`
- Create: `lib/supabase/browser.ts`
- Test: `tests/unit/roadmap-types.test.ts`

**Interfaces:**
- Produces: `RoadmapStatus`, `Project`, `RoadmapItem`, `SuggestionInput`, `VoteResult`, `STATUS_COLUMNS`.
- Produces: `getSupabaseBrowserClient(): SupabaseClient`.

- [ ] **Step 1: Write failing domain tests**

```ts
import { describe, expect, it } from "vitest"
import { STATUS_COLUMNS, isRoadmapStatus } from "@/features/roadmap/types"

describe("roadmap status model", () => {
  it("keeps the five required statuses in display order", () => {
    expect(STATUS_COLUMNS.map((column) => column.value)).toEqual([
      "pending", "approved", "in_progress", "completed", "rejected",
    ])
  })

  it("rejects unknown statuses", () => {
    expect(isRoadmapStatus("archived")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run: `npm run test:run -- tests/unit/roadmap-types.test.ts`

Expected: FAIL with module resolution error for `features/roadmap/types`.

- [ ] **Step 3: Define focused domain types**

```ts
export const STATUS_COLUMNS = [
  { value: "pending", label: "待处理" },
  { value: "approved", label: "已批准" },
  { value: "in_progress", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "rejected", label: "已拒绝" },
] as const

export type RoadmapStatus = (typeof STATUS_COLUMNS)[number]["value"]
export const isRoadmapStatus = (value: string): value is RoadmapStatus =>
  STATUS_COLUMNS.some((column) => column.value === value)

export interface Project {
  id: string
  name: string
  slug: string
  projectUrl: string | null
  sortOrder: number
}

export interface RoadmapItem {
  id: string
  projectId: string
  title: string
  description: string
  status: RoadmapStatus
  sortOrder: number
  voteCount: number
  createdAt: string
  updatedAt: string
}

export interface SuggestionInput {
  projectId: string
  title: string
  description: string
}

export interface VoteResult {
  voteCount: number
  duplicate: boolean
}
```

Implement `getSupabaseBrowserClient()` as a lazy singleton that throws a Chinese configuration error when any public variable is empty, and calls `createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run test:run -- tests/unit/roadmap-types.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add features/roadmap/types.ts lib/supabase/browser.ts tests/unit/roadmap-types.test.ts
git commit -m "feat: define roadmap domain model"
```

---

### Task 3: Supabase schema, seed data, grants, and RLS

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/20260824000000_roadmap.sql`
- Create: `supabase/tests/database/roadmap.test.sql`

**Interfaces:**
- Produces tables `projects`, `roadmap_items`, `votes`.
- Produces read view `roadmap_items_public` with snake_case columns and `vote_count bigint`.
- Produces one authenticated admin role model: write policies require the signed JWT email `roadmap-admin@internal.invalid`, while signup remains disabled and only that account is provisioned.

- [ ] **Step 1: Write failing pgTAP assertions**

Create a pgTAP transaction that asserts the three tables, the public view, the unique key `(roadmap_item_id, ip_hash)`, five allowed status values, four seed projects in order, anonymous SELECT access, anonymous mutation denial, and authenticated mutation access.

Core assertions:

```sql
begin;
select plan(12);
select has_table('public', 'projects');
select has_table('public', 'roadmap_items');
select has_table('public', 'votes');
select has_view('public', 'roadmap_items_public');
select results_eq(
  $$select name from public.projects order by sort_order$$,
  $$values ('广告系统'::text), ('ks-alert'::text), ('模板工具'::text), ('其他'::text)$$
);
select * from finish();
rollback;
```

- [ ] **Step 2: Run the DB test to verify it fails**

Run: `npx supabase start && npm run supabase:test`

Expected: FAIL because the migration/schema is absent. If Docker is unavailable, record that infrastructure limitation and continue with `npx supabase db lint` plus linked-project verification before release.

- [ ] **Step 3: Implement schema and seed**

The migration must create:

```sql
create extension if not exists pgcrypto;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  project_url text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roadmap_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  status text not null default 'pending' check (status in ('pending','approved','in_progress','completed','rejected')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  roadmap_item_id uuid not null references public.roadmap_items(id) on delete cascade,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (roadmap_item_id, ip_hash)
);
```

Add an `updated_at` trigger, indexes on project/status/order and vote item IDs, and idempotent seed inserts for `advertising-system`, `ks-alert`, `template-tools`, and `other`.

Create `roadmap_items_public` selecting only item fields plus `count(v.id)::bigint AS vote_count`; grant anonymous/authenticated SELECT on projects and the view, not on `votes`.

Enable RLS on all tables. Add a stable SQL helper that checks the signed JWT email:

```sql
create or replace function public.is_roadmap_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'email') = 'roadmap-admin@internal.invalid', false)
$$;
```

Policies:

```sql
create policy "public reads projects" on public.projects for select to anon, authenticated using (true);
create policy "public reads items" on public.roadmap_items for select to anon, authenticated using (true);
create policy "admin writes projects" on public.projects for all to authenticated
  using ((select public.is_roadmap_admin())) with check ((select public.is_roadmap_admin()));
create policy "admin writes items" on public.roadmap_items for all to authenticated
  using ((select public.is_roadmap_admin())) with check ((select public.is_roadmap_admin()));
```

Revoke anonymous direct INSERT/UPDATE/DELETE and all access to `votes`; Edge Functions use the service role.

- [ ] **Step 4: Run DB verification**

Run: `npm run supabase:test && npx supabase db lint`

Expected: all pgTAP assertions PASS and lint reports no errors.

- [ ] **Step 5: Commit**

```powershell
git add supabase/config.toml supabase/migrations/20260824000000_roadmap.sql supabase/tests/database/roadmap.test.sql
git commit -m "feat: add roadmap database and policies"
```

---

### Task 4: Anonymous suggestion and IP-constrained vote functions

**Files:**
- Create: `supabase/functions/_shared/cors.ts`
- Create: `supabase/functions/_shared/http.ts`
- Create: `supabase/functions/_shared/vote-security.ts`
- Create: `supabase/functions/submit-suggestion/index.ts`
- Create: `supabase/functions/vote/index.ts`
- Modify: `supabase/config.toml`
- Test: `tests/unit/vote-security.test.ts`

**Interfaces:**
- Produces: `normalizeIp(value: string): string` and `hashIp(ip: string, salt: string): Promise<string>`.
- Produces: `POST /functions/v1/submit-suggestion` body `SuggestionInput`, response `{ itemId: string }`.
- Produces: `POST /functions/v1/vote` body `{ roadmapItemId: string }`, response `VoteResult`.

- [ ] **Step 1: Write failing security tests**

```ts
import { describe, expect, it } from "vitest"
import { hashIp, normalizeIp } from "../../supabase/functions/_shared/vote-security"

describe("vote IP protection", () => {
  it("maps IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7")
  })

  it("creates a stable non-reversible identifier", async () => {
    const first = await hashIp("203.0.113.7", "test-salt")
    const second = await hashIp("203.0.113.7", "test-salt")
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toContain("203.0.113.7")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run -- tests/unit/vote-security.test.ts`

Expected: FAIL because the shared module is missing.

- [ ] **Step 3: Implement IP normalization, HMAC, CORS, and JSON responses**

Use `npm:ipaddr.js@2.2.0` to parse and normalize IPv4/IPv6. Use Web Crypto:

```ts
const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(salt),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
)
const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip))
return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
```

`cors.ts` parses `ALLOWED_ORIGINS` as a comma-separated allowlist, returns the request origin only when allowed, supports `OPTIONS`, and never uses `*` for production writes.

- [ ] **Step 4: Implement `submit-suggestion`**

Use Zod with exact limits (`projectId` UUID, title 2–120 trimmed characters, description max 4000). Create a service-role client from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; verify project existence and insert only `{ project_id, title, description, status: "pending" }`. Return 201 with the new ID; return 400/404/500 with stable Chinese messages.

- [ ] **Step 5: Implement `vote`**

Read only `request.headers.get("cf-connecting-ip")`; return 400 when absent. Normalize/hash with `VOTE_IP_SALT`, insert `{ roadmap_item_id, ip_hash }`, interpret PostgreSQL unique violation `23505` as `duplicate: true`, then query `roadmap_items_public` for the latest count.

Set both functions to `verify_jwt = false` in `supabase/config.toml`; validate the publishable `apikey` header and exact Origin inside each function before any service-role operation.

- [ ] **Step 6: Verify functions**

Run: `npm run test:run -- tests/unit/vote-security.test.ts && npx supabase functions serve --env-file supabase/.env.local`

Expected: unit tests PASS; local OPTIONS returns allowed CORS headers; missing client IP returns 400; repeated injected test IP returns a duplicate result after one insert; the same IP can vote for a different item; a different IP can vote for the same item.

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions supabase/config.toml tests/unit/vote-security.test.ts
git commit -m "feat: add anonymous roadmap functions"
```

---

### Task 5: Public data API and Roadmap interface

**Files:**
- Create: `features/roadmap/api.ts`
- Create: `features/roadmap/use-roadmap.ts`
- Create: `components/roadmap/roadmap-app.tsx`
- Create: `components/roadmap/project-switcher.tsx`
- Create: `components/roadmap/roadmap-board.tsx`
- Create: `components/roadmap/roadmap-card.tsx`
- Create: `components/roadmap/item-details.tsx`
- Create: `components/roadmap/suggestion-dialog.tsx`
- Modify: `app/page.tsx`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Test: `tests/unit/roadmap-board.test.tsx`
- Test: `tests/unit/suggestion-dialog.test.tsx`

**Interfaces:**
- Consumes: `Project`, `RoadmapItem`, `SuggestionInput`, `VoteResult`, `STATUS_COLUMNS`, `getSupabaseBrowserClient()`.
- Produces: `listProjects()`, `listRoadmapItems(projectId)`, `submitSuggestion(input)`, `voteForItem(itemId)`.
- Produces: public `/` UI.

- [ ] **Step 1: Write failing board and form tests**

Board test renders one item per status and asserts five named regions in order, real counts, empty states, and a vote callback receiving the item ID. Form test asserts required title, 120-character limit, project selection, retained values after rejected submit, and reset after success.

Representative assertion:

```tsx
render(<RoadmapBoard items={items} onOpenItem={vi.fn()} onVote={onVote} />)
expect(screen.getAllByRole("region").map((node) => node.getAttribute("aria-label")))
  .toEqual(["待处理", "已批准", "进行中", "已完成", "已拒绝"])
await user.click(screen.getByRole("button", { name: /为“导出报表”投票/ }))
expect(onVote).toHaveBeenCalledWith("item-1")
```

- [ ] **Step 2: Run focused tests and confirm missing components fail**

Run: `npm run test:run -- tests/unit/roadmap-board.test.tsx tests/unit/suggestion-dialog.test.tsx`

Expected: FAIL with missing component modules.

- [ ] **Step 3: Implement API mapping**

Map Supabase snake_case rows to domain camelCase in one place. `listRoadmapItems` selects from `roadmap_items_public` by `project_id`, ordered by `status, sort_order, created_at`. Edge Function calls use `supabase.functions.invoke`; expected errors return typed `Error` messages.

- [ ] **Step 4: Implement public UI and state hook**

`useRoadmap` owns projects, selected project ID, items, loading/error state, submission, and vote refresh. After a successful suggestion, refetch current items. After a vote, update only that item's `voteCount`; duplicate response leaves count unchanged and exposes “当前网络已投过票”.

Build the five-column board from `STATUS_COLUMNS`. Use Lucide icons, semantic buttons, native links with `target="_blank" rel="noreferrer"`, accessible labels, visible focus, skeleton loading, and explicit empty/error states. Render descriptions as text.

- [ ] **Step 5: Apply the pulled UI baseline**

Update metadata to Chinese Roadmap copy, set `<html lang="zh-CN">`, retain Inter and the existing blue token family. Use a responsive board with `grid-auto-columns: minmax(18rem, 1fr)` and horizontal overflow below the five-column desktop breakpoint.

- [ ] **Step 6: Run tests and verify the public page**

Run: `npm run test:run -- tests/unit/roadmap-board.test.tsx tests/unit/suggestion-dialog.test.tsx && npm run typecheck && npm run lint`

Expected: all PASS.

- [ ] **Step 7: Commit**

```powershell
git add app components/roadmap features/roadmap tests/unit/roadmap-board.test.tsx tests/unit/suggestion-dialog.test.tsx
git commit -m "feat: build public roadmap experience"
```

---

### Task 6: Password-only admin workspace and CRUD

**Files:**
- Create: `app/admin/layout.tsx`
- Create: `app/admin/page.tsx`
- Create: `features/admin/use-admin-session.ts`
- Create: `features/roadmap/admin-api.ts`
- Create: `components/admin/admin-app.tsx`
- Create: `components/admin/admin-login.tsx`
- Create: `components/admin/admin-toolbar.tsx`
- Create: `components/admin/project-dialog.tsx`
- Create: `components/admin/item-dialog.tsx`
- Create: `components/admin/admin-board.tsx`
- Test: `tests/unit/admin-login.test.tsx`
- Test: `tests/unit/admin-api.test.ts`

**Interfaces:**
- Consumes: public domain types and Supabase browser client.
- Produces: `signInAdmin(password)`, `signOutAdmin()`, `subscribeToAdminSession(callback)`.
- Produces: `createProject`, `updateProject`, `deleteProject`, `createRoadmapItem`, `updateRoadmapItem`, `deleteRoadmapItem`, `moveRoadmapItem`.

- [ ] **Step 1: Write failing admin tests**

Login test asserts only a password field is visible, empty submit is rejected, the fixed email plus password are passed to Supabase, failed login shows “密码不正确”, and success renders the workspace. API tests assert snake_case payloads, URL normalization, status validation, and delete restriction errors remain readable.

```tsx
render(<AdminLogin onSubmit={onSubmit} pending={false} error={null} />)
expect(screen.getByLabelText("管理密码")).toHaveAttribute("type", "password")
expect(screen.queryByLabelText(/邮箱/)).not.toBeInTheDocument()
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `npm run test:run -- tests/unit/admin-login.test.tsx tests/unit/admin-api.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement Supabase Auth boundary**

`signInAdmin(password)` reads `NEXT_PUBLIC_ADMIN_EMAIL`, calls `auth.signInWithPassword`, and maps invalid credentials to “密码不正确”. `useAdminSession` calls `auth.getSession()` once and subscribes with `auth.onAuthStateChange`; it cleans up the subscription. Public signup is never called.

- [ ] **Step 4: Implement authenticated CRUD API**

Each method validates with Zod before Supabase mutation and returns mapped domain values. `moveRoadmapItem(id, status, sortOrder)` updates those exact fields. Treat foreign-key restriction `23503` on project deletion as “请先删除或移动该项目中的 Roadmap 条目”.

- [ ] **Step 5: Implement admin workspace**

Unauthenticated state shows only `AdminLogin`; authenticated state shows project controls, board, add/edit dialogs, status select, drag-and-drop via dnd-kit, destructive confirmation, and logout. Drag end calculates the destination status and sequential `sort_order`, then persists and rolls back UI state on failure. All controls have text labels/tooltips and keyboard alternatives.

- [ ] **Step 6: Verify admin behavior**

Run: `npm run test:run -- tests/unit/admin-login.test.tsx tests/unit/admin-api.test.ts && npm run typecheck && npm run lint && npm run build`

Expected: tests PASS; static build contains `out/admin/index.html`; no server-feature static export errors.

- [ ] **Step 7: Commit**

```powershell
git add app/admin components/admin features/admin features/roadmap/admin-api.ts tests/unit/admin-login.test.tsx tests/unit/admin-api.test.ts
git commit -m "feat: add password protected admin workspace"
```

---

### Task 7: Security headers, strong-password tool, deployment runbook, and E2E

**Files:**
- Create: `public/_headers`
- Create: `scripts/generate-admin-password.mjs`
- Create: `playwright.config.ts`
- Test: `tests/unit/admin-password.test.ts`
- Create: `tests/e2e/public-roadmap.spec.ts`
- Create: `tests/e2e/admin.spec.ts`
- Create: `docs/deployment.md`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `npm run admin-password` printing one unpersisted 30+ character password.
- Produces: exact Supabase, Cloudflare Pages, custom domain, DNS, and rollback instructions.

- [ ] **Step 1: Write failing password tool test**

Add an exported `generatePassword()` and test it through Vitest:

```ts
import { expect, it } from "vitest"
import { generatePassword } from "../../scripts/generate-admin-password.mjs"

it("generates a strong password without whitespace", () => {
  const password = generatePassword()
  expect(password.length).toBeGreaterThanOrEqual(30)
  expect(password).toMatch(/[A-Z]/)
  expect(password).toMatch(/[a-z]/)
  expect(password).toMatch(/[0-9]/)
  expect(password).toMatch(/[!@#$%^&*]/)
  expect(password).not.toMatch(/\s/)
})
```

- [ ] **Step 2: Run the test and observe the missing generator failure**

Run: `npm run test:run -- tests/unit/admin-password.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement password generation and Cloudflare headers**

Use `node:crypto.randomBytes`, rejection sampling over a fixed alphabet, shuffle with cryptographic random indices, and force at least one character from each required class. The script prints only to stdout and never writes a file.

Create `public/_headers` with `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and `X-Frame-Options: DENY`. Allow connections only to `https://*.supabase.co` and `wss://*.supabase.co` beyond self.

- [ ] **Step 4: Add deterministic E2E fixtures and flows**

Configure Playwright `webServer` to run `npm run dev` and use Chromium. Intercept Supabase REST/Auth/Function requests with fixed fixtures. Public test covers project switching, suggestion success, first vote, duplicate vote, and mobile horizontal board. Admin test covers password-only form, login failure/success, project create/edit/delete restriction, item status change, and logout.

- [ ] **Step 5: Write exact deployment instructions**

`docs/deployment.md` must include:

1. Supabase dashboard values to copy: Project URL, Publishable Key, Project Ref.
2. Run migration and deploy functions with Supabase CLI.
3. Generate a password, create `roadmap-admin@internal.invalid` in Auth, disable “Allow new users to sign up”.
4. Set Function Secrets: `VOTE_IP_SALT` and `ALLOWED_ORIGINS`; keep built-in service-role secret server-side.
5. Cloudflare Pages: production branch `master`, build command `npm run build`, output directory `out`, Node.js 22, and the three `NEXT_PUBLIC_*` variables.
6. Add the custom hostname in Pages before DNS. The intended Pages project name is `roadmap-ui`, so the expected manual record is `CNAME roadmap -> roadmap-ui.pages.dev`; use the exact generated Pages hostname if Cloudflare assigns a different one. If DNS is already on Cloudflare, Pages creates/manages the record.
7. Verify HTTPS, `/`, `/admin/`, suggestion, vote, duplicate vote, logout, RLS denial, and rollback to the previous Pages deployment.
8. Explain Supabase Free project inactivity pausing and resume steps.

- [ ] **Step 6: Run full verification**

Run:

```powershell
npm run test:run
npm run test:e2e
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: all tests/checks PASS; `out/index.html`, `out/admin/index.html`, and `out/_headers` exist; no secret-like values are tracked.

- [ ] **Step 7: Commit**

```powershell
git add public/_headers scripts tests playwright.config.ts docs/deployment.md README.md package.json package-lock.json
git commit -m "docs: add secure cloud deployment workflow"
```

---

### Task 8: Linked Supabase and production smoke verification

**Files:**
- Modify only if verification finds defects in files owned by Tasks 1–7.

**Interfaces:**
- Consumes: user's Supabase Project Ref, Project URL, Publishable Key, chosen production hostname, Supabase CLI authentication, and Cloudflare access.
- Produces: migrated database, deployed Edge Functions, Cloudflare Pages deployment, custom domain, and final admin password handoff.

- [ ] **Step 1: Collect deployment inputs without putting secrets in chat or Git**

Have the user set credentials locally or in platform dashboards. Required non-secret values may be shared normally; Supabase access tokens, database passwords, service-role keys, and the generated admin password must be entered directly into CLI prompts or dashboard secret fields.

- [ ] **Step 2: Link and verify Supabase**

Run:

```powershell
npx supabase link --project-ref $env:SUPABASE_PROJECT_REF
npx supabase db push
npx supabase functions deploy submit-suggestion --no-verify-jwt
npx supabase functions deploy vote --no-verify-jwt
```

Expected: migration applied once; both deployments succeed; no service-role value appears in terminal logs.

- [ ] **Step 3: Configure Supabase production values**

Run `npm run admin-password`, copy the result directly into the manually created admin Auth user, and set a separately generated stable `VOTE_IP_SALT` with `npx supabase secrets set`. Store the final origin in `$env:ROADMAP_PRODUCTION_ORIGIN` and set `ALLOWED_ORIGINS=$env:ROADMAP_PRODUCTION_ORIGIN`.

- [ ] **Step 4: Configure and deploy Cloudflare Pages**

Connect the Git repository, apply the build settings and public environment variables from `docs/deployment.md`, deploy `master`, then add the chosen custom hostname. Provide the user the exact DNS record after Cloudflare reveals the generated Pages target (expected `roadmap-ui.pages.dev`).

- [ ] **Step 5: Production smoke test**

Verify public load, four project seeds, project link behavior, anonymous suggestion, one successful vote, duplicate vote from the same IP, admin login, CRUD, logout, security headers, mobile viewport, and direct anonymous write denial.

- [ ] **Step 6: Record deployment outcome**

Add a short deployment-status section to `README.md` containing the production hostname, migration version, function names, and operational links without secrets. Commit only if the content contains no credential or password.
