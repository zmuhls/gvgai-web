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

`/api/cadavre/wall` stores shared wall pins as `system/cadavre_wall_post` records in the existing `public.telemetry_events` table, using the same server-only service role key. The existing `(event_type, created_at)` and `event_id` indexes cover wall reads and removals. Public wall posts carry no browser credential; each new post receives a random delete capability that the page keeps only in the browser that created it, while the event payload stores its SHA-256 hash.

Production also sets `CADAVRE_WALL_FALLBACK_PATH` to a mounted Railway volume. The wall mirrors every successful Supabase write to that file and uses it whenever Supabase is unavailable, so pins remain available across application deployments and restarts. `CADAVRE_WALL_SUPABASE_TIMEOUT_MS` bounds each Supabase attempt before the volume takes over.

## Cloud Readiness Check

After the migration is applied and the root `.env` has Supabase credentials, run:

```bash
npm run telemetry:check
```

The check inserts one `system/cloud_readiness_check` event through Supabase REST, reads `public.telemetry_minute_rollups`, and verifies the leaderboard read-model views. Before credentials are present, this command should fail with a missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` message.

## Backfill Local Fallback Events

Events captured before Supabase credentials exist are appended to `web/data/telemetry-events.jsonl`. After the cloud check passes, upload those events with duplicate protection:

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
