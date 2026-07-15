# Supabase Telemetry

Inference Arcade writes evaluation, UX, clickthrough, model, and trace events through the Node server. Browser code sends events to Express. Express writes batches to Supabase with the service role key, and writes `web/data/telemetry-events.jsonl` when credentials are missing or a Supabase write fails.

## Credentials

Put these in the repository root `.env`:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
SUPABASE_TELEMETRY_TABLE=telemetry_events
TELEMETRY_ENABLED=true
TELEMETRY_BATCH_SIZE=25
TELEMETRY_FLUSH_MS=3000
TELEMETRY_FALLBACK_MODE=on-error
TELEMETRY_STORE_PROMPTS=false
```

Keep `SUPABASE_SERVICE_ROLE_KEY` on the server. The browser never receives it.

## Migration

Apply the migrations in [web/supabase/migrations](./supabase/migrations/) in order, or link the project with the Supabase CLI and run:

```bash
supabase db push
```

The migrations create `public.telemetry_events`, `public.telemetry_minute_rollups`, `public.telemetry_completed_runs`, `public.telemetry_run_leaderboard`, `public.telemetry_model_usage`, and `public.telemetry_session_activity`. They also add composite indexes for dashboard filters, JSONB indexes for trace details, and RLS with no anon or authenticated table access. Server writes use the service role key.

## Cloud Readiness Check

After the migration is applied and the root `.env` has Supabase credentials, run:

```bash
npm run telemetry:check
```

The check inserts one `system/cloud_readiness_check` event through Supabase REST, reads `public.telemetry_minute_rollups`, and verifies the leaderboard read-model views. Before credentials are present, this command should fail with a missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` message.

## Durability: retry + automatic drain

Live writes are idempotent (`on_conflict=event_id`) and retried a few times on
transient failures (network errors, 429, 5xx — never on a deterministic 4xx)
before a batch is allowed to spill to `web/data/telemetry-events.jsonl`. Whenever
Supabase is reachable again, the store **automatically replays** that fallback
file back into the table on its next flush tick (rotating it to
`telemetry-events.jsonl.draining` so concurrent writes are never lost), so events
that spilled during an outage are not stranded on ephemeral disk. Because the
replay is idempotent, a partially-uploaded file never produces duplicate rows.
Retry/drain behaviour is tunable via `TELEMETRY_WRITE_RETRIES` and
`TELEMETRY_WRITE_RETRY_MS`.

## Backfill Local Fallback Events (manual)

The automatic drain covers events that spill while the server is running. For a
one-off upload of a `web/data/telemetry-events.jsonl` captured before credentials
existed (or on another machine), run the manual backfill with the same duplicate
protection:

```bash
npm run telemetry:backfill -- --dry-run
npm run telemetry:backfill
```

The backfill command uses `event_id` as the conflict key, so re-running it does not duplicate rows that already reached Supabase.

The dashboard also reads recent rows from this JSONL fallback when Supabase credentials are absent, so local leaderboard rows and event logs can survive a server restart while cloud setup is pending.

## Event Families

- `evaluation`: game starts, eval batches, run summaries, wins, losses, score, ticks.
- `user_experience`: page load, socket connection, API timing, search and UI state.
- `clickthrough`: navigation, game selection, strategy selection, start and stop actions.
- `model_telemetry`: provider, model id, latency, action, response length, fallback errors.
- `trace`: level init, sampled game ticks, score and health changes.
- `system`: server start and stop.

Full prompt and model response text are omitted by default. Set `TELEMETRY_STORE_PROMPTS=true` only when the project has an explicit reason to store raw prompt traces.

## Dashboard and API

Start the app from `web/`:

```bash
npm start
```

Open `http://localhost:3000` and select the `Telemetry` tab. The dashboard reads:

- `GET /api/telemetry/summary`
- `GET /api/telemetry/events`
- `POST /api/telemetry/events`
- `POST /api/telemetry/flush`

When Supabase credentials are configured, `GET /api/telemetry/summary` and `GET /api/telemetry/events` read recent rows from `public.telemetry_events`. Without credentials, or if a cloud read fails, the dashboard falls back to the current server process memory and recent rows in `web/data/telemetry-events.jsonl`. The dashboard status strip shows whether it is reading `supabase rows`, `local fallback`, or `local memory`.

The summary response also renders the arcade leaderboard:

- Runs rank completed live runs and eval cases by wins, best score, average score, and volume.
- Usage ranks models by decision count, average latency, prompt characters, response characters, and providers.
- Sessions rank active browser sessions and run ids by clickthrough, starts, summaries, decisions, and recent activity.

The dashboard also renders the write path from recent captured rows to the in-process buffer, Supabase writes, JSONL fallback writes, and failures. This makes it clear whether the stream is backed by Supabase, local fallback, or memory during development.

CLI evals also feed the same store:

```bash
node scripts/run-arcade-eval.js --dry-run --game-count 1 --model gpt-oss:120b --limit 3
```
