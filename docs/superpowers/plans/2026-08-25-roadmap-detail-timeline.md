# Roadmap Detail Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public Roadmap detail sheet with a responsive dialog that loads and displays an immutable, day-accurate status timeline recorded automatically by Supabase.

**Architecture:** A new append-only `roadmap_status_history` table and database trigger record initial and changed statuses transactionally. The public frontend fetches a safe history view each time a detail dialog opens, maps it into typed entries, groups events by `Asia/Shanghai` date, and renders a responsive two-column dialog without realtime subscriptions.

**Tech Stack:** Next.js 16 App Router static export, React 19, TypeScript 5, Base UI Dialog, Tailwind CSS 4, Supabase Postgres/RLS, pgTAP, Vitest, React Testing Library, Playwright, Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-08-25-roadmap-detail-timeline-design.md`

## Global Constraints

- Preserve the five exact statuses: `pending`, `approved`, `in_progress`, `completed`, `rejected`.
- Display timeline dates as `YYYY-MM-DD` in `Asia/Shanghai`; never derive the day from the browser's local timezone.
- Record only inserts and true status changes; title, description, vote, and sort changes must not append history.
- Preserve repeated and reverse status transitions in chronological order.
- Keep public clients read-only for history; trigger writes and state updates must share one database transaction.
- Fetch history when the dialog opens or retries; do not add Supabase Realtime, WebSocket, or polling.
- Keep voting behavior and one-public-IP-per-item enforcement unchanged.
- Do not restart or recreate the local `roadmap-cloud` Supabase Docker stack; database tests and migrations use the linked cloud project.
- Do not expose `.env.deploy.local`, passwords, database URLs, access tokens, or service keys in output or committed files.
- Commit messages are Chinese. Push and deploy only after all checks pass.

---

## File Map

- Create `supabase/migrations/20260825090000_roadmap_status_history.sql`: history table, trigger, backfill, view, RLS, grants.
- Modify `supabase/tests/database/roadmap.test.sql`: pgTAP contract and transactional history behavior.
- Modify `features/roadmap/types.ts`: public status-history and timeline view-model types.
- Modify `features/roadmap/api.ts`: database row mapper and public history query.
- Create `features/roadmap/timeline.ts`: China-date formatting, creation-node merge, grouping, labels.
- Create `features/roadmap/use-roadmap-history.ts`: per-open load/retry state and stale-request protection.
- Create `components/roadmap/item-timeline.tsx`: presentational loading/error/timeline states.
- Modify `components/roadmap/item-details.tsx`: replace Sheet with Dialog and compose the timeline.
- Create `tests/unit/roadmap-timeline.test.ts`: deterministic date and grouping tests.
- Modify `tests/unit/roadmap-api.test.ts`: history row mapping validation.
- Create `tests/unit/use-roadmap-history.test.tsx`: load, retry, close, and race behavior.
- Create `tests/unit/item-details.test.tsx`: dialog accessibility, content, timeline, retry, and voting.
- Modify `tests/e2e/public-roadmap.spec.ts`: public history route and reopen/mobile behavior.
- Modify `docs/deployment.md`: status-history migration and production verification note.

---

### Task 1: Transactional Status-History Database Contract

**Files:**
- Create: `supabase/migrations/20260825090000_roadmap_status_history.sql`
- Modify: `supabase/tests/database/roadmap.test.sql`

**Interfaces:**
- Consumes: `public.roadmap_items`, its five-state constraint, `created_at`, `updated_at`, and the existing `roadmap_items_set_updated_at` trigger.
- Produces: `public.roadmap_status_history`, `public.roadmap_status_history_public`, and `public.record_roadmap_status_history()`.

- [ ] **Step 1: Add failing pgTAP schema assertions**

Change `select plan(39)` to `select plan(53)`. Add these eight schema assertions for the table, safe view, RLS, index, trigger function, trigger, anon read privilege, and lack of anon insert privilege:

```sql
select has_table('public', 'roadmap_status_history', 'status history table exists');
select has_view('public', 'roadmap_status_history_public', 'public status history view exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.roadmap_status_history'::regclass),
  'status history enables RLS'
);
select has_index(
  'public',
  'roadmap_status_history',
  'roadmap_status_history_item_time_idx',
  'status history has stable item timeline index'
);
select has_function(
  'public',
  'record_roadmap_status_history',
  array[]::text[],
  'status history trigger function exists'
);
select has_trigger(
  'public',
  'roadmap_items',
  'roadmap_items_record_status_history',
  'roadmap item history trigger exists'
);
select ok(
  has_table_privilege('anon', 'public.roadmap_status_history_public', 'select'),
  'anon reads public status history'
);
select ok(
  not has_table_privilege('anon', 'public.roadmap_status_history', 'insert'),
  'anon cannot insert status history'
);
```

- [ ] **Step 2: Add failing pgTAP behavior assertions**

Around the existing fixture item `10000000-0000-4000-8000-000000000001`, add six behavior assertions for initial history, no event for non-status edits, one event per transition, reverse transitions, and cascade deletion. Put the initial and non-status assertions immediately after the fixture insert:

```sql
select is(
  (select count(*)::integer from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'item creation records initial status'
);

update public.roadmap_items
set description = '只修改说明'
where id = '10000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001'),
  1,
  'non-status update does not append history'
);

select results_eq(
  $$select from_status, to_status from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001' order by changed_at, id$$,
  $$values (null::text, 'pending'::text), ('pending'::text, 'in_progress'::text)$$,
  'status transition appends ordered history'
);

select public.move_roadmap_item(
  '10000000-0000-4000-8000-000000000001',
  'in_progress',
  0
);

select is(
  (select count(*)::integer from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001'),
  2,
  'same-status reorder does not append history'
);

select public.move_roadmap_item(
  '10000000-0000-4000-8000-000000000001',
  'approved',
  0
);

select is(
  (select count(*)::integer from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001'),
  3,
  'reverse transition preserves earlier history'
);
```

Place the `results_eq` assertion immediately after the existing `lives_ok`/`is` pair that moves the fixture from `pending` to `in_progress`; do not add a duplicate first transition call. Then run the same-status and reverse-transition calls shown above.

After the existing project-delete restriction assertion, delete the fixture item and assert the history rows are gone:

```sql
delete from public.roadmap_items
where id = '10000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.roadmap_status_history where roadmap_item_id = '10000000-0000-4000-8000-000000000001'),
  0,
  'item deletion cascades to status history'
);
```

- [ ] **Step 3: Run linked pgTAP tests and verify RED**

Load `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, and `SUPABASE_DB_PASSWORD` from `.env.deploy.local` into process memory without printing values, then run:

```powershell
npx supabase test db --linked
```

Expected: FAIL because `roadmap_status_history` and its view/function/trigger do not exist. Do not start local Docker.

- [ ] **Step 4: Create the migration**

Create `supabase/migrations/20260825090000_roadmap_status_history.sql` with this structure:

```sql
create table public.roadmap_status_history (
  id bigint generated always as identity primary key,
  roadmap_item_id uuid not null
    references public.roadmap_items(id) on delete cascade,
  from_status text
    check (from_status is null or from_status in ('pending', 'approved', 'in_progress', 'completed', 'rejected')),
  to_status text not null
    check (to_status in ('pending', 'approved', 'in_progress', 'completed', 'rejected')),
  changed_at timestamptz not null default now(),
  check (from_status is null or from_status <> to_status)
);

create index roadmap_status_history_item_time_idx
  on public.roadmap_status_history (roadmap_item_id, changed_at, id);

create or replace function public.record_roadmap_status_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.roadmap_status_history (
      roadmap_item_id,
      from_status,
      to_status,
      changed_at
    ) values (new.id, null, new.status, new.created_at);
  elsif old.status is distinct from new.status then
    insert into public.roadmap_status_history (
      roadmap_item_id,
      from_status,
      to_status,
      changed_at
    ) values (new.id, old.status, new.status, new.updated_at);
  end if;

  return new;
end;
$$;

insert into public.roadmap_status_history (
  roadmap_item_id,
  from_status,
  to_status,
  changed_at
)
select id, null, status, updated_at
from public.roadmap_items;

create trigger roadmap_items_record_status_history
after insert or update of status on public.roadmap_items
for each row execute function public.record_roadmap_status_history();

create view public.roadmap_status_history_public
with (security_invoker = true, security_barrier = true)
as
select id, roadmap_item_id, from_status, to_status, changed_at
from public.roadmap_status_history;

alter table public.roadmap_status_history enable row level security;

create policy "public reads status history"
on public.roadmap_status_history
for select
to anon, authenticated
using (true);

revoke all on function public.record_roadmap_status_history() from public;
revoke all on table public.roadmap_status_history from anon, authenticated;
revoke all on table public.roadmap_status_history_public from anon, authenticated;
grant select on table public.roadmap_status_history to anon, authenticated;
grant select on table public.roadmap_status_history_public to anon, authenticated;

comment on table public.roadmap_status_history is
  'Append-only roadmap status history written by a database trigger.';
comment on view public.roadmap_status_history_public is
  'Public-safe roadmap status transitions with no actor or sensitive identifiers.';
```

- [ ] **Step 5: Dry-run and apply the cloud migration**

Using the same in-memory deployment inputs, run:

```powershell
npx supabase db push --linked --dry-run --password $env:SUPABASE_DB_PASSWORD
npx supabase db push --linked --password $env:SUPABASE_DB_PASSWORD --yes
```

Expected dry run: exactly `20260825090000_roadmap_status_history.sql` is pending. Expected push: migration succeeds transactionally.

- [ ] **Step 6: Run linked pgTAP tests and verify GREEN**

Run:

```powershell
npx supabase test db --linked
```

Expected: all planned assertions pass and the pgTAP transaction rolls back fixture writes.

Run a read-only invariant query against the linked project and assert zero items lack history:

```sql
select count(*)
from public.roadmap_items item
where not exists (
  select 1
  from public.roadmap_status_history history
  where history.roadmap_item_id = item.id
);
```

Expected: `0`.

- [ ] **Step 7: Commit the database contract**

```powershell
git add supabase/migrations/20260825090000_roadmap_status_history.sql supabase/tests/database/roadmap.test.sql
git commit -m "功能：记录 Roadmap 状态历史"
```

---

### Task 2: Typed History API and Day-Level Timeline Model

**Files:**
- Modify: `features/roadmap/types.ts`
- Modify: `features/roadmap/api.ts`
- Create: `features/roadmap/timeline.ts`
- Modify: `tests/unit/roadmap-api.test.ts`
- Create: `tests/unit/roadmap-timeline.test.ts`

**Interfaces:**
- Consumes: `RoadmapItem`, `RoadmapStatus`, `STATUS_COLUMNS`, and `roadmap_status_history_public`.
- Produces: `RoadmapStatusHistoryEntry`, `RoadmapTimelineGroup`, `mapRoadmapStatusHistoryRow()`, `listRoadmapStatusHistory()`, `formatRoadmapDate()`, and `buildRoadmapTimeline()`.

- [ ] **Step 1: Write failing history-mapper tests**

Extend `tests/unit/roadmap-api.test.ts`:

```ts
import { mapRoadmapStatusHistoryRow } from "@/features/roadmap/api"

it("maps a status history row into the UI model", () => {
  expect(
    mapRoadmapStatusHistoryRow({
      id: 7,
      roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      from_status: "approved",
      to_status: "in_progress",
      changed_at: "2026-08-24T16:30:00.000Z",
    }),
  ).toEqual({
    id: 7,
    roadmapItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fromStatus: "approved",
    toStatus: "in_progress",
    changedAt: "2026-08-24T16:30:00.000Z",
  })
})

it("rejects an unknown status in history", () => {
  expect(() =>
    mapRoadmapStatusHistoryRow({
      id: 8,
      roadmap_item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      from_status: "approved",
      to_status: "archived",
      changed_at: "2026-08-24T16:30:00.000Z",
    }),
  ).toThrow("Roadmap 状态历史无效")
})
```

- [ ] **Step 2: Write failing date/grouping tests**

Create `tests/unit/roadmap-timeline.test.ts` with these independent cases:

```ts
import { describe, expect, it } from "vitest"

import {
  buildRoadmapTimeline,
  formatRoadmapDate,
} from "@/features/roadmap/timeline"
import type {
  RoadmapItem,
  RoadmapStatusHistoryEntry,
} from "@/features/roadmap/types"

const item: RoadmapItem = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "告警通知聚合",
  description: "",
  status: "in_progress",
  sortOrder: 0,
  voteCount: 0,
  createdAt: "2026-08-24T15:30:00.000Z",
  updatedAt: "2026-08-25T02:00:00.000Z",
}

it("formats the day in Asia/Shanghai", () => {
  expect(formatRoadmapDate("2026-08-24T16:30:00.000Z")).toBe("2026-08-25")
})

it("merges a same-day null baseline into task creation", () => {
  const history: RoadmapStatusHistoryEntry[] = [{
    id: 1,
    roadmapItemId: item.id,
    fromStatus: null,
    toStatus: "pending",
    changedAt: "2026-08-24T15:31:00.000Z",
  }]

  expect(buildRoadmapTimeline(item, history)).toEqual([{
    date: "2026-08-24",
    events: [{
      key: "created",
      kind: "created",
      label: "任务创建",
      toStatus: "pending",
    }],
  }])
})

it("keeps every real transition in a shared day group", () => {
  const history: RoadmapStatusHistoryEntry[] = [
    {
      id: 1,
      roadmapItemId: item.id,
      fromStatus: null,
      toStatus: "pending",
      changedAt: item.createdAt,
    },
    {
      id: 2,
      roadmapItemId: item.id,
      fromStatus: "pending",
      toStatus: "approved",
      changedAt: "2026-08-25T01:00:00.000Z",
    },
    {
      id: 3,
      roadmapItemId: item.id,
      fromStatus: "approved",
      toStatus: "in_progress",
      changedAt: "2026-08-25T02:00:00.000Z",
    },
  ]

  expect(buildRoadmapTimeline(item, history)[1].events).toEqual([
    {
      key: "history-2",
      kind: "transition",
      label: "待处理 → 已批准",
      fromStatus: "pending",
      toStatus: "approved",
    },
    {
      key: "history-3",
      kind: "transition",
      label: "已批准 → 进行中",
      fromStatus: "approved",
      toStatus: "in_progress",
    },
  ])
})
```

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/roadmap-timeline.test.ts
```

Expected: FAIL because the history types, mapper, and timeline functions do not exist.

- [ ] **Step 4: Add types and the history mapper/query**

Add to `features/roadmap/types.ts`:

```ts
export interface RoadmapStatusHistoryEntry {
  id: number
  roadmapItemId: string
  fromStatus: RoadmapStatus | null
  toStatus: RoadmapStatus
  changedAt: string
}

export interface RoadmapTimelineEvent {
  key: string
  kind: "created" | "baseline" | "transition"
  label: string
  fromStatus?: RoadmapStatus
  toStatus: RoadmapStatus
}

export interface RoadmapTimelineGroup {
  date: string
  events: RoadmapTimelineEvent[]
}
```

Add the exported mapper and query to `features/roadmap/api.ts`:

```ts
interface RoadmapStatusHistoryRow {
  id: number
  roadmap_item_id: string
  from_status: string | null
  to_status: string
  changed_at: string
}

export function mapRoadmapStatusHistoryRow(
  row: RoadmapStatusHistoryRow,
): RoadmapStatusHistoryEntry {
  if (
    (row.from_status !== null && !isRoadmapStatus(row.from_status)) ||
    !isRoadmapStatus(row.to_status) ||
    !Number.isSafeInteger(row.id)
  ) {
    throw new Error("Roadmap 状态历史无效")
  }

  return {
    id: row.id,
    roadmapItemId: row.roadmap_item_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedAt: row.changed_at,
  }
}

export async function listRoadmapStatusHistory(
  itemId: string,
): Promise<RoadmapStatusHistoryEntry[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("roadmap_status_history_public")
    .select("id,roadmap_item_id,from_status,to_status,changed_at")
    .eq("roadmap_item_id", itemId)
    .order("changed_at", { ascending: true })
    .order("id", { ascending: true })

  if (error) throw new Error("状态时间轴加载失败，请稍后重试")
  return ((data ?? []) as RoadmapStatusHistoryRow[]).map(
    mapRoadmapStatusHistoryRow,
  )
}
```

- [ ] **Step 5: Implement deterministic timeline grouping**

Create `features/roadmap/timeline.ts`. Use `Intl.DateTimeFormat(...).formatToParts()` so output is always `YYYY-MM-DD`, map status values through `STATUS_COLUMNS`, create the item creation event first, merge only `fromStatus === null` events on the creation day into that creation event, and append every non-null transition:

```ts
const chinaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function formatRoadmapDate(value: string): string {
  const parts = Object.fromEntries(
    chinaDateFormatter
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}
```

`buildRoadmapTimeline(item, history)` must sort a copy by `changedAt` then `id`, never mutate its input, label a later `fromStatus === null` entry as `当前状态`, and label real transitions as `${fromLabel} → ${toLabel}`.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/roadmap-timeline.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit the typed data layer**

```powershell
git add features/roadmap/types.ts features/roadmap/api.ts features/roadmap/timeline.ts tests/unit/roadmap-api.test.ts tests/unit/roadmap-timeline.test.ts
git commit -m "功能：读取并整理状态时间轴"
```

---

### Task 3: Per-Open History Loader and Responsive Detail Dialog

**Files:**
- Create: `features/roadmap/use-roadmap-history.ts`
- Create: `components/roadmap/item-timeline.tsx`
- Modify: `components/roadmap/item-details.tsx`
- Create: `tests/unit/use-roadmap-history.test.tsx`
- Create: `tests/unit/item-details.test.tsx`

**Interfaces:**
- Consumes: `listRoadmapStatusHistory(itemId)`, `buildRoadmapTimeline(item, history)`, existing `ItemDetails` props, Base UI `Dialog`, `Badge`, `Button`, and `Skeleton`.
- Produces: `useRoadmapHistory(itemId)`, `ItemTimeline`, and a dialog-based `ItemDetails` with unchanged parent-facing props.

- [ ] **Step 1: Write failing hook tests for load, retry, reset, and stale requests**

Mock only `listRoadmapStatusHistory`. In `tests/unit/use-roadmap-history.test.tsx`, verify:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const first = deferred<RoadmapStatusHistoryEntry[]>()
const second = deferred<RoadmapStatusHistoryEntry[]>()
vi.mocked(listRoadmapStatusHistory)
  .mockReturnValueOnce(first.promise)
  .mockReturnValueOnce(second.promise)

const { result, rerender } = renderHook(
  ({ itemId }) => useRoadmapHistory(itemId),
  { initialProps: { itemId: "item-a" as string | null } },
)

rerender({ itemId: "item-b" })
second.resolve([historyB])
await waitFor(() => expect(result.current.entries).toEqual([historyB]))
first.resolve([historyA])
await waitFor(() => expect(result.current.entries).toEqual([historyB]))
```

Add separate assertions that `itemId = null` clears entries/error and that `retry()` calls the API again for the current ID.

- [ ] **Step 2: Write failing dialog tests**

In `tests/unit/item-details.test.tsx`, mock the history hook with explicit loading, error, and success states. Verify:

```tsx
render(
  <ItemDetails
    item={item}
    voting={false}
    onOpenChange={onOpenChange}
    onVote={onVote}
  />,
)

expect(screen.getByRole("dialog")).toBeInTheDocument()
expect(screen.getByRole("heading", { name: item.title })).toBeInTheDocument()
expect(screen.getByText("2026-08-25")).toBeInTheDocument()
expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull()
```

Add independent tests for:

- loading skeleton in the “进展时间轴” region;
- error text plus “重新加载” calling `retry`;
- transition labels rendered in chronological order;
- clicking the vote button calls `onVote(item.id)`;
- dialog close calls `onOpenChange(false)`.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm run test:run -- tests/unit/use-roadmap-history.test.tsx tests/unit/item-details.test.tsx
```

Expected: FAIL because the hook, timeline component, and dialog implementation do not exist.

- [ ] **Step 4: Implement `useRoadmapHistory`**

Create `features/roadmap/use-roadmap-history.ts` with this public shape:

```ts
export interface RoadmapHistoryState {
  entries: RoadmapStatusHistoryEntry[]
  loading: boolean
  error: string | null
  retry(): void
}

export function useRoadmapHistory(itemId: string | null): RoadmapHistoryState
```

Use a monotonically increasing `requestVersion` ref. Every item change, close, and retry starts a new version; only the latest version may set entries, error, or loading. Clear old entries immediately when `itemId` changes or becomes null. Error copy is the thrown message or `状态时间轴加载失败，请稍后重试`.

- [ ] **Step 5: Implement the presentational timeline**

Create `components/roadmap/item-timeline.tsx` with explicit props:

```ts
interface ItemTimelineProps {
  groups: RoadmapTimelineGroup[]
  loading: boolean
  error: string | null
  onRetry(): void
}
```

Render a section with `aria-label="进展时间轴"`. Use `Clock3`, `Circle`, and `RefreshCw` from Lucide; never use Unicode glyphs as icons. Each group renders its exact date once and each event beneath it. Loading renders three `Skeleton` rows. Error renders the message and an outline “重新加载” button. The vertical rule and blue active nodes use existing `border-border`, `bg-primary`, and `text-primary` tokens.

- [ ] **Step 6: Replace the Sheet with a Dialog**

In `components/roadmap/item-details.tsx`:

- replace all `Sheet*` imports/usages with `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, and `DialogTitle`;
- call `useRoadmapHistory(item?.id ?? null)` and `buildRoadmapTimeline(item, history.entries)`;
- use `DialogContent className="max-h-[calc(100svh-2rem)] overflow-hidden p-0 sm:max-w-3xl"`;
- use a scrollable `grid min-h-0 overflow-y-auto md:grid-cols-[minmax(0,1.25fr)_minmax(16rem,0.75fr)]` body;
- keep current status badge, title, created date, description, vote button, IP explanation, and non-commitment footer copy;
- render `ItemTimeline` in the right column and preserve `onOpenChange` behavior.

The visible title remains the actual item title. Standard actions remain “重新加载” and “关闭”; do not add decorative filler copy.

- [ ] **Step 7: Run focused tests and verify GREEN**

```powershell
npm run test:run -- tests/unit/use-roadmap-history.test.tsx tests/unit/item-details.test.tsx
```

Expected: all focused tests pass with no React act warnings.

- [ ] **Step 8: Run related unit tests**

```powershell
npm run test:run -- tests/unit/roadmap-api.test.ts tests/unit/roadmap-timeline.test.ts tests/unit/use-roadmap-history.test.tsx tests/unit/item-details.test.tsx tests/unit/roadmap-board.test.tsx tests/unit/use-roadmap.test.tsx
```

Expected: all related tests pass.

- [ ] **Step 9: Commit the dialog feature**

```powershell
git add features/roadmap/use-roadmap-history.ts components/roadmap/item-timeline.tsx components/roadmap/item-details.tsx tests/unit/use-roadmap-history.test.tsx tests/unit/item-details.test.tsx
git commit -m "功能：详情弹窗展示状态时间轴"
```

---

### Task 4: Public End-to-End Contract and Responsive Verification

**Files:**
- Modify: `tests/e2e/public-roadmap.spec.ts`

**Interfaces:**
- Consumes: public item cards, `roadmap_status_history_public`, the dialog, and the existing Playwright Supabase route harness.
- Produces: browser-level coverage for modal opening, per-open refresh, China-date display, keyboard close, and mobile containment.

- [ ] **Step 1: Add the failing mocked history route**

Inside `installPublicApi`, keep a `historyRequests` counter and return one initial baseline plus one transition. Match the PostgREST route separately from `roadmap_items_public`:

```ts
let historyRequests = 0

await page.route(
  "https://e2e.supabase.co/rest/v1/roadmap_status_history_public**",
  async (route) => {
    historyRequests += 1
    await route.fulfill({
      json: [
        {
          id: 1,
          roadmap_item_id: ITEM_ALERT,
          from_status: null,
          to_status: "pending",
          changed_at: "2026-08-24T08:00:00.000Z",
        },
        ...(historyRequests > 1
          ? [{
              id: 2,
              roadmap_item_id: ITEM_ALERT,
              from_status: "pending",
              to_status: "approved",
              changed_at: "2026-08-24T16:30:00.000Z",
            }]
          : []),
      ],
    })
  },
)
```

- [ ] **Step 2: Add the failing dialog/reopen/mobile E2E test**

Add a separate Playwright test:

```ts
test("详情弹窗按每次打开刷新精确到日的状态时间轴", async ({ page }) => {
  await installPublicApi(page)
  await page.goto("/")
  await page.getByLabel("切换项目").selectOption(PROJECT_ALERT)

  await page.getByRole("button", { name: "查看详情" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "告警通知聚合" })).toBeVisible()
  await expect(dialog.getByText("2026-08-24")).toBeVisible()
  await expect(dialog.locator('[data-slot="sheet-content"]')).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "查看详情" }).click()
  await expect(page.getByText("待处理 → 已批准")).toBeVisible()
  await expect(page.getByText("2026-08-25")).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.getByRole("dialog").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
  expect(metrics.clientHeight).toBeLessThanOrEqual(812)
})
```

- [ ] **Step 3: Run the E2E test and verify RED**

```powershell
npm run test:e2e -- tests/e2e/public-roadmap.spec.ts
```

Expected: FAIL because the current implementation renders a sheet and never requests history.

- [ ] **Step 4: Make only fixture-selector corrections required by real output**

If Base UI's accessible close name or transition scoping differs, adjust the selector to the rendered accessible role/name. Do not weaken assertions to generic text presence and do not remove the dialog, date, re-open, or overflow checks.

- [ ] **Step 5: Run the E2E test and verify GREEN**

```powershell
npm run test:e2e -- tests/e2e/public-roadmap.spec.ts
```

Expected: both the existing public workflow and new dialog timeline workflow pass.

- [ ] **Step 6: Commit the browser contract**

```powershell
git add tests/e2e/public-roadmap.spec.ts
git commit -m "测试：覆盖详情弹窗时间轴"
```

---

### Task 5: Documentation, Full Verification, Push, and Production Rollout

**Files:**
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: completed migration, public API, dialog implementation, `.env.deploy.local`, linked Supabase, GitHub `origin/master`, and Cloudflare Pages project `roadmap-ui`.
- Produces: verified production migration and static deployment on `telljax.com` and `admin.telljax.com`.

- [ ] **Step 1: Document the new production verification**

Add a short deployment note after the Supabase migration section:

```markdown
状态时间轴迁移会创建 `roadmap_status_history`、自动记录触发器和公开安全视图。迁移后运行 `npx supabase test db --linked`，并确认每个现有 `roadmap_items` 至少有一条历史基线。前端不使用 Realtime；每次打开详情弹窗时读取最新历史。
```

- [ ] **Step 2: Run all unit tests**

```powershell
npm run test:run
```

Expected: every Vitest suite passes with zero failures.

- [ ] **Step 3: Run all E2E tests**

```powershell
npm run test:e2e
```

Expected: public and admin Playwright suites pass with zero failures.

- [ ] **Step 4: Run static checks**

```powershell
npm run lint
npm run typecheck
```

Expected: both commands exit `0` with no errors.

- [ ] **Step 5: Run cloud database verification**

Load linked Supabase credentials from `.env.deploy.local` without printing them, then run:

```powershell
npx supabase db push --linked --dry-run --password $env:SUPABASE_DB_PASSWORD
npx supabase test db --linked
```

Expected: no pending migrations and all pgTAP tests pass.

- [ ] **Step 6: Build the production static export with public Supabase values**

Map `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from `.env.deploy.local` into `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in process memory, then run:

```powershell
npm run build
```

Expected: Next.js reports successful compile, TypeScript, and static routes `/`, `/admin`, and `/icon.svg`. Search the generated files and assert both public values are embedded without printing their values.

- [ ] **Step 7: Verify the local Docker cleanup remains intact**

```powershell
docker container ls --all --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.ID}}'
docker volume ls --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.Name}}'
docker network ls --filter "label=com.supabase.cli.project=roadmap-cloud" --format '{{.ID}}'
```

Expected: all three commands return no resources.

- [ ] **Step 8: Commit documentation and any final mechanical fixes**

```powershell
git add docs/deployment.md
git diff --cached --check
git commit -m "文档：补充状态时间轴上线检查"
```

If `docs/deployment.md` is the only remaining change, the commit contains only that file. Do not combine unrelated user changes.

- [ ] **Step 9: Verify branch state and push**

```powershell
git status --short --branch
git log --oneline origin/master..master
git push origin master
```

Expected before push: clean working tree and only the reviewed Chinese commits ahead of `origin/master`. Expected after push: `master` matches `origin/master`.

- [ ] **Step 10: Deploy the verified static export to Cloudflare Pages**

Load `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_PAGES_PROJECT` from `.env.deploy.local` without printing values, then run:

```powershell
npx wrangler pages deploy out --project-name=roadmap-ui --branch=master
```

Expected: a production deployment with the latest Git commit and status `success`.

- [ ] **Step 11: Verify both production domains and the public history endpoint**

For `https://telljax.com` and `https://admin.telljax.com` verify:

- page status is `200` after redirects;
- `admin.telljax.com` still resolves to `/admin/`;
- static assets use the latest deployment;
- a Roadmap card opens a centered `dialog`;
- the timeline displays `YYYY-MM-DD` dates and does not render sheet content;
- the public history REST query returns `200` using only the publishable key;
- reopening the dialog performs a new history request;
- voting remains functional without casting an extra production vote during smoke testing.

Run a final Cloudflare deployment query and record only deployment ID, status, commit hash, and URL. Do not print credentials.

- [ ] **Step 12: Final repository verification**

```powershell
git status --short --branch
git log -1 --oneline
```

Expected: `master...origin/master` with no working-tree changes and the final Chinese commit at `HEAD`.
