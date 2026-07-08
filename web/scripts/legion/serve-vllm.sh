#!/usr/bin/env bash
# Launch the persistent vLLM multi-LoRA server on the Legion.
# Auto-discovers every /srv/adapters/<name>/lora and exposes it as a hot-swappable
# LoRA module whose NAME == the request `model` field == the arcade registry id.
# Starting with zero adapters present is fine (base model only) — retrain/hot-add later.
#
# Env:  VLLM_VENV      (default /srv/vllm-serve)
#       BASE_MODEL     (default unsloth/gemma-3-4b-it)
#       ADAPTERS_DIR   (default /srv/adapters)
#       VLLM_PORT      (default 8000)
#       MAX_LORA_RANK  (default 16 — must be >= the adapter rank; finetune.py uses 16)
#       MAX_LORAS      (default 8  — concurrent adapters resident in VRAM)
set -euo pipefail

VLLM_VENV="${VLLM_VENV:-/srv/vllm-serve}"
BASE_MODEL="${BASE_MODEL:-unsloth/gemma-3-4b-it}"
ADAPTERS_DIR="${ADAPTERS_DIR:-/srv/adapters}"
VLLM_PORT="${VLLM_PORT:-8000}"
MAX_LORA_RANK="${MAX_LORA_RANK:-16}"
MAX_LORAS="${MAX_LORAS:-8}"

# shellcheck disable=SC1091
[ -f "$VLLM_VENV/bin/activate" ] && source "$VLLM_VENV/bin/activate"

lora_args=()
if [ -d "$ADAPTERS_DIR" ]; then
  for d in "$ADAPTERS_DIR"/*/ ; do
    [ -d "${d}lora" ] || continue
    name="$(basename "$d")"
    lora_args+=("${name}=${d}lora")
  done
fi

echo "[legion] base    : $BASE_MODEL"
echo "[legion] port    : $VLLM_PORT (host 0.0.0.0 — reachable over Tailscale)"
echo "[legion] adapters: ${lora_args[*]:-<none yet; serving base only>}"

# Runtime LoRA add/remove via POST /v1/load_lora_adapter without a restart.
export VLLM_ALLOW_RUNTIME_LORA_UPDATING=1

exec vllm serve "$BASE_MODEL" \
  --enable-lora \
  --max-lora-rank "$MAX_LORA_RANK" \
  --max-loras "$MAX_LORAS" \
  --host 0.0.0.0 \
  --port "$VLLM_PORT" \
  --allowed-origins '["*"]' \
  ${lora_args[@]:+--lora-modules "${lora_args[@]}"}
