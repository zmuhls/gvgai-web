#!/usr/bin/env bash
# One-shot Supabase telemetry setup for Inference Arcade.
# Prerequisite: `supabase login` has been run on this machine.
#
# Creates (or reuses) a Supabase project named "inference-arcade", applies the
# migrations in web/supabase/migrations/, writes credentials into the repo root
# .env, then runs the readiness check and backfills local JSONL events.
#
# Usage: bash web/scripts/setup-supabase-telemetry.sh
#   SUPABASE_REGION=us-east-1 (default) can be overridden via env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$REPO_ROOT/web"
ENV_FILE="$REPO_ROOT/.env"
MIGRATIONS_DIR="$WEB_DIR/supabase/migrations"
PROJECT_NAME="inference-arcade"
REGION="${SUPABASE_REGION:-us-east-1}"
PSQL="${PSQL:-/Library/PostgreSQL/17/bin/psql}"

log() { printf '\n[setup] %s\n' "$*"; }
fail() { printf '\n[setup] ERROR: %s\n' "$*" >&2; exit 1; }

command -v supabase >/dev/null || fail "supabase CLI not found (brew install supabase/tap/supabase)"
[ -x "$PSQL" ] || PSQL="$(command -v psql || true)"
[ -n "$PSQL" ] || fail "psql not found"
[ -d "$MIGRATIONS_DIR" ] || fail "migrations dir missing: $MIGRATIONS_DIR"

log "checking supabase auth..."
if ! supabase projects list -o json >/tmp/sb-projects.json 2>/dev/null; then
  fail "not logged in. Run: supabase login   (then re-run this script)"
fi

EXISTING_REF="$(jq -r --arg n "$PROJECT_NAME" '[.[] | select(.name == $n)][0].id // empty' /tmp/sb-projects.json)"

if [ -n "$EXISTING_REF" ]; then
  PROJECT_REF="$EXISTING_REF"
  log "project '$PROJECT_NAME' already exists (ref: $PROJECT_REF)"
  DB_PASSWORD="${SUPABASE_DB_PASSWORD:-$(grep -s '^SUPABASE_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- || true)}"
  [ -n "$DB_PASSWORD" ] || fail "existing project found but no SUPABASE_DB_PASSWORD in env or .env — set it (Dashboard > Settings > Database > Reset password) and re-run"
else
  ORG_ID="$(supabase orgs list -o json | jq -r '.[0].id // empty')"
  [ -n "$ORG_ID" ] || fail "no Supabase organization found on this account"
  DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-28)"
  log "creating project '$PROJECT_NAME' in org $ORG_ID (region $REGION)..."
  CREATE_OUT="$(supabase projects create "$PROJECT_NAME" --org-id "$ORG_ID" --db-password "$DB_PASSWORD" --region "$REGION" -o json)"
  PROJECT_REF="$(printf '%s' "$CREATE_OUT" | jq -r '.id // empty')"
  [ -n "$PROJECT_REF" ] || fail "project create returned no ref: $CREATE_OUT"
  log "created project ref: $PROJECT_REF"
fi

SUPABASE_URL="https://$PROJECT_REF.supabase.co"

log "waiting for project to become healthy..."
for i in $(seq 1 60); do
  STATUS="$(supabase projects list -o json | jq -r --arg r "$PROJECT_REF" '[.[] | select(.id == $r)][0].status // empty')"
  [ "$STATUS" = "ACTIVE_HEALTHY" ] && break
  sleep 10
done
[ "$STATUS" = "ACTIVE_HEALTHY" ] || fail "project not healthy after 10 minutes (status: ${STATUS:-unknown})"
log "project healthy"

log "fetching API keys..."
SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref "$PROJECT_REF" -o json | jq -r '[.[] | select(.name == "service_role")][0].api_key // empty')"
[ -n "$SERVICE_ROLE_KEY" ] || fail "could not read service_role key (try: supabase projects api-keys --project-ref $PROJECT_REF)"

log "applying migrations..."
DIRECT_URL="postgresql://postgres:$DB_PASSWORD@db.$PROJECT_REF.supabase.co:5432/postgres"
POOLER_URL="postgresql://postgres.$PROJECT_REF:$DB_PASSWORD@aws-0-$REGION.pooler.supabase.com:5432/postgres"
DB_URL=""
for candidate in "$DIRECT_URL" "$POOLER_URL"; do
  if "$PSQL" "$candidate" -c 'select 1' >/dev/null 2>&1; then DB_URL="$candidate"; break; fi
done
[ -n "$DB_URL" ] || fail "could not connect to database (tried direct and pooler)"
for f in "$MIGRATIONS_DIR"/*.sql; do
  log "  applying $(basename "$f")"
  "$PSQL" "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
log "migrations applied"

log "writing credentials to $ENV_FILE..."
touch "$ENV_FILE"
# strip any prior values for the keys we manage, then append fresh ones
TMP_ENV="$(mktemp)"
grep -vE '^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_TELEMETRY_TABLE|SUPABASE_DB_PASSWORD|TELEMETRY_ENABLED|TELEMETRY_BATCH_SIZE|TELEMETRY_FLUSH_MS|TELEMETRY_FALLBACK_MODE|TELEMETRY_STORE_PROMPTS)=' "$ENV_FILE" > "$TMP_ENV" || true
cat >> "$TMP_ENV" <<EOF

# Supabase telemetry (written by setup-supabase-telemetry.sh)
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
SUPABASE_DB_PASSWORD=$DB_PASSWORD
SUPABASE_TELEMETRY_TABLE=telemetry_events
TELEMETRY_ENABLED=true
TELEMETRY_BATCH_SIZE=25
TELEMETRY_FLUSH_MS=3000
TELEMETRY_FALLBACK_MODE=on-error
TELEMETRY_STORE_PROMPTS=false
EOF
mv "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "running cloud readiness check..."
(cd "$WEB_DIR" && npm run telemetry:check)

if [ -s "$WEB_DIR/data/telemetry-events.jsonl" ]; then
  log "backfilling local fallback events (dry run first)..."
  (cd "$WEB_DIR" && npm run telemetry:backfill -- --dry-run)
  (cd "$WEB_DIR" && npm run telemetry:backfill)
fi

log "done. Telemetry is live at $SUPABASE_URL (table: telemetry_events)."
