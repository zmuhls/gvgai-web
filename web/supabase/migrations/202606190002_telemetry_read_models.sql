create or replace view public.telemetry_completed_runs
with (security_invoker = on)
as
select
  event_id,
  created_at,
  run_id,
  game_id,
  level_id,
  coalesce(nullif(model_id, ''), nullif(payload->>'modelUsed', ''), 'unknown') as model_id,
  coalesce(nullif(provider, ''), nullif(payload->>'provider', '')) as provider,
  nullif(payload->>'winner', '') as winner,
  case
    when payload->>'won' = 'true' or payload->>'winner' = 'PLAYER_WINS' then true
    when payload->>'won' = 'false' or payload->>'winner' = 'PLAYER_LOSES' then false
    else null
  end as won,
  case
    when coalesce(metrics->>'final_score', metrics->>'score', payload->>'finalScore', payload->>'score') ~ '^-?[0-9]+(\.[0-9]+)?$'
      then coalesce(metrics->>'final_score', metrics->>'score', payload->>'finalScore', payload->>'score')::numeric
    else 0
  end as final_score,
  case
    when coalesce(metrics->>'ticks', payload->>'ticks') ~ '^[0-9]+$'
      then coalesce(metrics->>'ticks', payload->>'ticks')::integer
    else 0
  end as ticks,
  case
    when coalesce(metrics->>'decisions', payload->>'decisions') ~ '^[0-9]+$'
      then coalesce(metrics->>'decisions', payload->>'decisions')::integer
    else 0
  end as decisions
from public.telemetry_events
where event_family = 'evaluation'
  and event_type in ('run_summary', 'eval_case_completed');

create or replace view public.telemetry_run_leaderboard
with (security_invoker = on)
as
select
  model_id,
  count(*) as runs,
  count(*) filter (where won is true) as wins,
  count(*) filter (where won is false) as losses,
  count(*) filter (where won is null) as other,
  case
    when count(*) = 0 then 0
    else count(*) filter (where won is true)::numeric / count(*)
  end as win_rate,
  max(final_score) as best_score,
  avg(final_score) as avg_score,
  avg(ticks) as avg_ticks,
  avg(decisions) as avg_decisions,
  max(created_at) as latest_at
from public.telemetry_completed_runs
group by model_id;

create or replace view public.telemetry_model_usage
with (security_invoker = on)
as
select
  coalesce(nullif(model_id, ''), nullif(payload->>'modelUsed', ''), 'unknown') as model_id,
  count(*) as decisions,
  avg(latency_ms) filter (where latency_ms is not null) as avg_latency_ms,
  percentile_cont(0.95) within group (order by latency_ms) filter (where latency_ms is not null) as p95_latency_ms,
  sum(
    case when coalesce(metrics->>'prompt_chars', metrics->>'promptChars') ~ '^[0-9]+$'
      then coalesce(metrics->>'prompt_chars', metrics->>'promptChars')::integer
      else 0
    end
  ) as prompt_chars,
  sum(
    case when coalesce(metrics->>'system_prompt_chars', metrics->>'systemPromptChars') ~ '^[0-9]+$'
      then coalesce(metrics->>'system_prompt_chars', metrics->>'systemPromptChars')::integer
      else 0
    end
  ) as system_prompt_chars,
  sum(
    case when coalesce(metrics->>'response_chars', metrics->>'responseChars') ~ '^[0-9]+$'
      then coalesce(metrics->>'response_chars', metrics->>'responseChars')::integer
      else 0
    end
  ) as response_chars,
  array_remove(array_agg(distinct provider), null) as providers,
  max(created_at) as latest_at
from public.telemetry_events
where event_family = 'model_telemetry'
  and event_type = 'llm_decision'
group by 1;

create or replace view public.telemetry_session_activity
with (security_invoker = on)
as
select
  coalesce(
    nullif(session_id, ''),
    case when run_id is not null then 'run:' || run_id else null end,
    'unknown'
  ) as session_key,
  count(*) as events,
  count(*) filter (where event_family = 'clickthrough') as clicks,
  count(*) filter (where event_type = 'game_selected') as game_selections,
  count(*) filter (where event_type = 'game_start_clicked') as start_clicks,
  count(*) filter (where event_type = 'run_summary') as run_summaries,
  count(*) filter (where event_type = 'llm_decision') as decisions,
  array_remove(array_agg(distinct game_id), null) as game_ids,
  array_remove(array_agg(distinct model_id), null) as model_ids,
  array_remove(array_agg(distinct run_id), null) as run_ids,
  max(created_at) as latest_at
from public.telemetry_events
where session_id is not null
   or run_id is not null
group by 1;

revoke all on public.telemetry_completed_runs from anon;
revoke all on public.telemetry_completed_runs from authenticated;
revoke all on public.telemetry_run_leaderboard from anon;
revoke all on public.telemetry_run_leaderboard from authenticated;
revoke all on public.telemetry_model_usage from anon;
revoke all on public.telemetry_model_usage from authenticated;
revoke all on public.telemetry_session_activity from anon;
revoke all on public.telemetry_session_activity from authenticated;

comment on view public.telemetry_completed_runs is
  'Normalized completed run records from live play and eval batches.';

comment on view public.telemetry_run_leaderboard is
  'Model-level arcade leaderboard for completed runs and eval cases.';

comment on view public.telemetry_model_usage is
  'Model usage and latency read model for dashboard telemetry.';

comment on view public.telemetry_session_activity is
  'Browser session and run activity read model for user experience and clickthrough telemetry.';
