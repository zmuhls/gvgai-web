create extension if not exists pgcrypto;

create table if not exists public.telemetry_events (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_family text not null,
  event_type text not null,
  source text not null default 'server',
  session_id text,
  run_id text,
  game_id integer,
  level_id integer,
  model_id text,
  provider text,
  latency_ms integer,
  value numeric,
  payload jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  constraint telemetry_events_family_check check (
    event_family in (
      'evaluation',
      'user_experience',
      'clickthrough',
      'model_telemetry',
      'trace',
      'system'
    )
  ),
  constraint telemetry_events_latency_check check (latency_ms is null or latency_ms >= 0)
);

create unique index if not exists telemetry_events_event_id_idx
  on public.telemetry_events (event_id);

create index if not exists telemetry_events_family_created_idx
  on public.telemetry_events (event_family, created_at desc);

create index if not exists telemetry_events_type_created_idx
  on public.telemetry_events (event_type, created_at desc);

create index if not exists telemetry_events_run_created_idx
  on public.telemetry_events (run_id, created_at desc)
  where run_id is not null;

create index if not exists telemetry_events_model_created_idx
  on public.telemetry_events (model_id, created_at desc)
  where model_id is not null;

create index if not exists telemetry_events_game_created_idx
  on public.telemetry_events (game_id, level_id, created_at desc)
  where game_id is not null;

create index if not exists telemetry_events_payload_gin_idx
  on public.telemetry_events using gin (payload jsonb_path_ops);

create index if not exists telemetry_events_metrics_gin_idx
  on public.telemetry_events using gin (metrics jsonb_path_ops);

alter table public.telemetry_events enable row level security;
alter table public.telemetry_events force row level security;

revoke all on public.telemetry_events from anon;
revoke all on public.telemetry_events from authenticated;

create or replace view public.telemetry_minute_rollups
with (security_invoker = on)
as
select
  date_trunc('minute', created_at) as minute,
  event_family,
  event_type,
  model_id,
  game_id,
  count(*) as event_count,
  avg(latency_ms) filter (where latency_ms is not null) as avg_latency_ms,
  avg(value) filter (where value is not null) as avg_value
from public.telemetry_events
group by 1, 2, 3, 4, 5;

revoke all on public.telemetry_minute_rollups from anon;
revoke all on public.telemetry_minute_rollups from authenticated;

comment on table public.telemetry_events is
  'Append-only event log for Inference Arcade evaluations, UX events, clickthrough, model telemetry, and trace data. Writes should go through the server service role.';

comment on column public.telemetry_events.payload is
  'Event details. Full prompts and model responses are stored only when TELEMETRY_STORE_PROMPTS=true on the server.';
