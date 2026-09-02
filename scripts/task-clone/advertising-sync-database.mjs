import { buildTargetCloneInfrastructureSql } from "./database.mjs"

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,}$/
const CRON_SECRET_PATTERN = /^[a-f0-9]{64}$/
const SYNC_FUNCTION_URL_PATTERN =
  /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/sync-advertising$/

function encodedSqlText(value) {
  return `convert_from(decode('${Buffer.from(value, "utf8").toString("base64")}', 'base64'), 'UTF8')`
}

export function buildAdvertisingSyncInfrastructureSql(targetRef) {
  if (!PROJECT_REF_PATTERN.test(targetRef ?? "")) {
    throw new Error("目标 Supabase Project Ref 无效")
  }

  return `begin;
select pg_advisory_xact_lock(hashtextextended('roadmap:advertising-sync-schema', 0));

create table if not exists public.roadmap_advertising_sync_state (
  singleton boolean primary key default true check (singleton),
  active_run_id uuid,
  active_started_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_snapshot_digest text check (
    last_snapshot_digest is null or last_snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  last_counts jsonb,
  last_duration_ms integer check (last_duration_ms is null or last_duration_ms >= 0),
  last_error_code text,
  last_error_message text check (
    last_error_message is null or char_length(last_error_message) <= 500
  ),
  check ((active_run_id is null) = (active_started_at is null))
);

insert into public.roadmap_advertising_sync_state (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.roadmap_advertising_sync_object_cleanup (
  storage_path text primary key check (
    storage_path ~ '^suggestions/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(jpg|png)$'
  ),
  queued_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_message text check (
    last_error_message is null or char_length(last_error_message) <= 500
  )
);

create table if not exists public.roadmap_advertising_sync_http_requests (
  request_id bigint primary key,
  requested_at timestamptz not null default now()
);

alter table public.roadmap_advertising_sync_state enable row level security;
alter table public.roadmap_advertising_sync_object_cleanup enable row level security;
alter table public.roadmap_advertising_sync_http_requests enable row level security;
revoke all on table public.roadmap_advertising_sync_state from anon, authenticated;
revoke all on table public.roadmap_advertising_sync_object_cleanup from anon, authenticated;
revoke all on table public.roadmap_advertising_sync_http_requests from anon, authenticated;
grant all on table public.roadmap_advertising_sync_state to service_role;
grant all on table public.roadmap_advertising_sync_object_cleanup to service_role;
grant all on table public.roadmap_advertising_sync_http_requests to service_role;

create or replace function public.claim_advertising_roadmap_sync(run_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  updated_count integer := 0;
begin
  if not exists (
    select 1
    from public.roadmap_clone_import_markers
    where singleton
      and target_project_ref = '${targetRef}'
  ) then
    raise exception 'advertising_sync_target_identity_invalid'
      using errcode = '42501';
  end if;

  if not pg_try_advisory_xact_lock(
    hashtextextended('roadmap:advertising-sync', 0)
  ) then
    return false;
  end if;

  update public.roadmap_advertising_sync_state
  set active_run_id = run_id,
      active_started_at = clock_timestamp(),
      last_attempt_at = clock_timestamp(),
      last_error_code = null,
      last_error_message = null
  where singleton
    and (
      active_run_id is null
      or active_started_at < clock_timestamp() - interval '15 minutes'
    );
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$function$;

create or replace function public.apply_advertising_roadmap_snapshot(
  run_id uuid,
  snapshot jsonb,
  snapshot_digest text,
  duration_ms integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_project_id uuid;
  payload_project_id uuid;
  project_slug text;
  payload_project_slug text;
  item_count integer;
  history_count integer;
  image_count integer;
  inserted_count integer;
  cleanup_paths jsonb;
begin
  if not pg_try_advisory_xact_lock(
    hashtextextended('roadmap:advertising-sync', 0)
  ) then
    raise exception 'advertising_sync_busy' using errcode = '55P03';
  end if;

  if not exists (
    select 1
    from public.roadmap_clone_import_markers
    where singleton
      and target_project_ref = '${targetRef}'
  ) then
    raise exception 'advertising_sync_target_identity_invalid'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.roadmap_advertising_sync_state
    where singleton and active_run_id = run_id
    for update
  ) then
    raise exception 'advertising_sync_lease_invalid' using errcode = '42501';
  end if;

  payload_project_slug := snapshot #>> '{project,slug}';
  project_slug := payload_project_slug;
  if project_slug <> 'advertising-system'
    or payload_project_slug <> 'advertising-system'
    or snapshot ->> 'version' <> '1'
    or jsonb_typeof(snapshot -> 'items') <> 'array'
    or jsonb_typeof(snapshot -> 'histories') <> 'array'
    or jsonb_typeof(snapshot -> 'images') <> 'array'
    or snapshot_digest !~ '^[0-9a-f]{64}$'
    or duration_ms < 0
  then
    raise exception 'advertising_sync_payload_invalid' using errcode = '22023';
  end if;

  payload_project_id := (snapshot #>> '{project,id}')::uuid;
  item_count := jsonb_array_length(snapshot -> 'items');
  history_count := jsonb_array_length(snapshot -> 'histories');
  image_count := jsonb_array_length(snapshot -> 'images');
  if item_count > 5000 or history_count > 50000 or image_count > 5000 then
    raise exception 'advertising_sync_payload_too_large' using errcode = '54000';
  end if;

  select id into current_project_id
  from public.projects
  where slug = 'advertising-system';

  if exists (
    select 1 from public.projects
    where id = payload_project_id and slug <> 'advertising-system'
  ) or exists (
    select 1
    from jsonb_array_elements(snapshot -> 'items') as payload(item)
    join public.roadmap_items as target
      on target.id = (payload.item ->> 'id')::uuid
    join public.projects as target_project on target_project.id = target.project_id
    where target_project.slug <> 'advertising-system'
  ) or exists (
    select 1
    from jsonb_array_elements(snapshot -> 'images') as payload(image)
    join public.roadmap_item_images as target
      on target.id = (payload.image ->> 'id')::uuid
    join public.roadmap_items as target_item on target_item.id = target.roadmap_item_id
    join public.projects as target_project on target_project.id = target_item.project_id
    where target_project.slug <> 'advertising-system'
  ) then
    raise exception 'advertising_sync_target_uuid_conflict' using errcode = '23505';
  end if;

  if current_project_id is not null then
    insert into public.roadmap_advertising_sync_object_cleanup (storage_path)
    select image.storage_path
    from public.roadmap_item_images as image
    join public.roadmap_items as item on item.id = image.roadmap_item_id
    where item.project_id = current_project_id
    on conflict (storage_path) do nothing;

    delete from public.votes
    where roadmap_item_id in (
      select id from public.roadmap_items where project_id = current_project_id
    );
    delete from public.roadmap_item_images
    where roadmap_item_id in (
      select id from public.roadmap_items where project_id = current_project_id
    );
    delete from public.roadmap_status_history
    where roadmap_item_id in (
      select id from public.roadmap_items where project_id = current_project_id
    );
    delete from public.roadmap_items where project_id = current_project_id;
    delete from public.projects where id = current_project_id;
  end if;

  insert into public.projects (
    id, name, slug, project_url, sort_order, created_at, updated_at
  )
  select
    (project ->> 'id')::uuid,
    project ->> 'name',
    project ->> 'slug',
    nullif(project ->> 'projectUrl', ''),
    (project ->> 'sortOrder')::integer,
    (project ->> 'createdAt')::timestamptz,
    (project ->> 'updatedAt')::timestamptz
  from jsonb_to_record(snapshot) as root(project jsonb);

  insert into public.roadmap_items (
    id, project_id, title, description, status, sort_order,
    created_at, updated_at, vote_baseline
  )
  select
    id, project_id, title, description, status, sort_order,
    created_at, updated_at, vote_baseline
  from jsonb_to_recordset(snapshot -> 'items') as item(
    id uuid,
    "projectId" uuid,
    title text,
    description text,
    status text,
    "sortOrder" integer,
    "createdAt" timestamptz,
    "updatedAt" timestamptz,
    "voteBaseline" bigint
  )
  cross join lateral (
    select
      item."projectId" as project_id,
      item."sortOrder" as sort_order,
      item."createdAt" as created_at,
      item."updatedAt" as updated_at,
      item."voteBaseline" as vote_baseline
  ) as normalized;
  get diagnostics inserted_count = row_count;
  if inserted_count <> item_count then
    raise exception 'advertising_sync_item_count_mismatch';
  end if;

  delete from public.roadmap_status_history
  where roadmap_item_id in (
    select id from public.roadmap_items where project_id = payload_project_id
  );

  insert into public.roadmap_status_history (
    roadmap_item_id, from_status, to_status, changed_at
  )
  select
    "roadmapItemId", "fromStatus", "toStatus", "changedAt"
  from jsonb_to_recordset(snapshot -> 'histories') as history(
    "sourceOrder" bigint,
    "roadmapItemId" uuid,
    "fromStatus" text,
    "toStatus" text,
    "changedAt" timestamptz
  )
  order by "sourceOrder";
  get diagnostics inserted_count = row_count;
  if inserted_count <> history_count then
    raise exception 'advertising_sync_history_count_mismatch';
  end if;

  insert into public.roadmap_item_images (
    id, roadmap_item_id, storage_path, mime_type,
    size_bytes, width, height, created_at
  )
  select
    id, "roadmapItemId", "storagePath", "mimeType",
    "sizeBytes", width, height, "createdAt"
  from jsonb_to_recordset(snapshot -> 'images') as image(
    id uuid,
    "roadmapItemId" uuid,
    "storagePath" text,
    "mimeType" text,
    "sizeBytes" integer,
    width integer,
    height integer,
    "createdAt" timestamptz,
    sha256 text
  )
  where sha256 ~ '^[0-9a-f]{64}$';
  get diagnostics inserted_count = row_count;
  if inserted_count <> image_count then
    raise exception 'advertising_sync_image_count_mismatch';
  end if;

  delete from public.roadmap_advertising_sync_object_cleanup as cleanup
  using jsonb_to_recordset(snapshot -> 'images') as image("storagePath" text)
  where cleanup.storage_path = image."storagePath";

  update public.roadmap_advertising_sync_state
  set active_run_id = null,
      active_started_at = null,
      last_success_at = clock_timestamp(),
      last_snapshot_digest = snapshot_digest,
      last_counts = jsonb_build_object(
        'projects', 1,
        'items', item_count,
        'histories', history_count,
        'images', image_count
      ),
      last_duration_ms = duration_ms,
      last_error_code = null,
      last_error_message = null
  where singleton and active_run_id = run_id;

  select coalesce(jsonb_agg(storage_path order by storage_path), '[]'::jsonb)
  into cleanup_paths
  from public.roadmap_advertising_sync_object_cleanup;

  return jsonb_build_object(
    'applied', true,
    'counts', jsonb_build_object(
      'projects', 1,
      'items', item_count,
      'histories', history_count,
      'images', image_count
    ),
    'cleanupPaths', cleanup_paths
  );
end;
$function$;

create or replace function public.fail_advertising_roadmap_sync(
  run_id uuid,
  error_code text,
  error_message text,
  duration_ms integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from public.roadmap_clone_import_markers
    where singleton and target_project_ref = '${targetRef}'
  ) then
    raise exception 'advertising_sync_target_identity_invalid'
      using errcode = '42501';
  end if;
  update public.roadmap_advertising_sync_state
  set active_run_id = null,
      active_started_at = null,
      last_duration_ms = greatest(duration_ms, 0),
      last_error_code = left(error_code, 80),
      last_error_message = left(error_message, 500)
  where singleton and active_run_id = run_id;
end;
$function$;

create or replace function public.confirm_advertising_object_cleanup(paths text[])
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  delete from public.roadmap_advertising_sync_object_cleanup
  where storage_path = any(paths)
$function$;

create or replace function public.record_advertising_object_cleanup_failure(
  path text,
  error_code text
)
returns void
language sql
volatile
security definer
set search_path = ''
as $function$
  update public.roadmap_advertising_sync_object_cleanup
  set attempts = attempts + 1,
      last_attempt_at = clock_timestamp(),
      last_error_code = left(error_code, 80),
      last_error_message = '对象清理失败'
  where storage_path = path
$function$;

revoke all on function public.claim_advertising_roadmap_sync(uuid) from public;
revoke all on function public.apply_advertising_roadmap_snapshot(uuid, jsonb, text, integer) from public;
revoke all on function public.fail_advertising_roadmap_sync(uuid, text, text, integer) from public;
revoke all on function public.confirm_advertising_object_cleanup(text[]) from public;
revoke all on function public.record_advertising_object_cleanup_failure(text, text) from public;
grant execute on function public.claim_advertising_roadmap_sync(uuid) to service_role;
grant execute on function public.apply_advertising_roadmap_snapshot(uuid, jsonb, text, integer) to service_role;
grant execute on function public.fail_advertising_roadmap_sync(uuid, text, text, integer) to service_role;
grant execute on function public.confirm_advertising_object_cleanup(text[]) to service_role;
grant execute on function public.record_advertising_object_cleanup_failure(text, text) to service_role;

commit;`
}

export function buildAdvertisingSyncVaultSql(input) {
  const allowed = new Set(["functionUrl", "publishableKey", "cronSecret"])
  if (Object.keys(input ?? {}).some((key) => !allowed.has(key))) {
    throw new Error("Vault 配置包含禁止字段")
  }
  const { functionUrl, publishableKey, cronSecret } = input ?? {}
  if (!SYNC_FUNCTION_URL_PATTERN.test(functionUrl ?? "")) {
    throw new Error("同步函数 URL 无效")
  }
  if (!PUBLISHABLE_KEY_PATTERN.test(publishableKey ?? "")) {
    throw new Error("目标 Publishable Key 无效")
  }
  if (!CRON_SECRET_PATTERN.test(cronSecret ?? "")) {
    throw new Error("同步 Cron Secret 无效")
  }

  const entries = [
    ["advertising_sync_function_url", functionUrl],
    ["advertising_sync_publishable_key", publishableKey],
    ["advertising_sync_cron_secret", cronSecret],
  ]
  return `begin;
create extension if not exists supabase_vault with schema vault;
do $vault$
declare
  current_secret_id uuid;
begin
${entries
  .map(
    ([
      name,
      value,
    ]) => `  select id into current_secret_id from vault.secrets where name = '${name}';
  if current_secret_id is null then
    perform vault.create_secret(${encodedSqlText(value)}, '${name}', 'Roadmap advertising sync');
  else
    perform vault.update_secret(current_secret_id, ${encodedSqlText(value)}, '${name}', 'Roadmap advertising sync');
  end if;`
  )
  .join("\n")}
end;
$vault$;
commit;`
}

export function buildAdvertisingSyncCronSql({ active }) {
  if (typeof active !== "boolean") throw new Error("Cron active 状态无效")
  return `begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid)
from cron.job
where jobname = 'sync-advertising-roadmap-hourly';
select cron.schedule(
  'sync-advertising-roadmap-hourly',
  '17 * * * *',
  $cron$
  with requested as (
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'advertising_sync_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'advertising_sync_publishable_key'),
        'x-roadmap-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'advertising_sync_cron_secret')
      ),
      body := jsonb_build_object('scheduledAt', clock_timestamp())
    ) as request_id
  ), tracked as (
    insert into public.roadmap_advertising_sync_http_requests (request_id)
    select request_id from requested
    returning request_id
  )
  delete from public.roadmap_advertising_sync_http_requests as old_request
  where old_request.request_id <> (select request_id from tracked);
  $cron$
);
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'sync-advertising-roadmap-hourly'),
  active := ${active ? "true" : "false"}
);
commit;`
}

export function buildAdvertisingSyncStatusSql() {
  return `select jsonb_build_object(
  'lastAttemptAt', state.last_attempt_at,
  'lastSuccessAt', state.last_success_at,
  'lastSnapshotDigest', state.last_snapshot_digest,
  'lastCounts', state.last_counts,
  'lastDurationMs', state.last_duration_ms,
  'lastErrorCode', state.last_error_code,
  'busy', state.active_run_id is not null,
  'cleanup_count', (
    select count(*) from public.roadmap_advertising_sync_object_cleanup
  ),
  'cron', (
    select jsonb_build_object(
      'schedule', job.schedule,
      'active', job.active
    )
    from cron.job as job
    where job.jobname = 'sync-advertising-roadmap-hourly'
  ),
  'net', (
    select jsonb_build_object(
      'requestId', tracked.request_id::text,
      'requestedAt', tracked.requested_at,
      'statusCode', response.status_code,
      'timedOut', coalesce(response.timed_out, false),
      'hasError', response.error_msg is not null,
      'receivedAt', response.created
    )
    from public.roadmap_advertising_sync_http_requests as tracked
    left join net._http_response as response on response.id = tracked.request_id
    order by tracked.requested_at desc
    limit 1
  )
) as status
from public.roadmap_advertising_sync_state as state
where state.singleton;`
}

export function buildAdvertisingSyncTargetTestSql(targetRef, testSql) {
  if (typeof testSql !== "string" || !testSql.trim().endsWith("rollback;")) {
    throw new Error("目标同步 pgTAP 测试 SQL 无效")
  }
  return `${buildTargetCloneInfrastructureSql(targetRef)}\n${buildAdvertisingSyncInfrastructureSql(targetRef)}\n${testSql}`
}
