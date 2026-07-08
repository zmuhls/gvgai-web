#!/usr/bin/env bash
# One-time Legion setup for the multi-LoRA vLLM serving path.
# The Legion already has the Unsloth training env (see ../FINETUNE.md); this adds
# a separate vLLM serving venv so the two dependency sets don't collide.
#
# Usage:  bash bootstrap.sh
# Env:    VLLM_VENV      (default /srv/vllm-serve)
#         BASE_MODEL     (default unsloth/gemma-3-4b-it)
#         HF_TOKEN       (only if the base model repo is gated)
set -euo pipefail

VLLM_VENV="${VLLM_VENV:-/srv/vllm-serve}"
BASE_MODEL="${BASE_MODEL:-unsloth/gemma-3-4b-it}"

echo "[legion] creating vLLM serving venv at $VLLM_VENV"
python3 -m venv "$VLLM_VENV"
# shellcheck disable=SC1091
source "$VLLM_VENV/bin/activate"
pip install --upgrade pip
pip install vllm huggingface_hub

echo "[legion] versions:"
python - <<'PY'
import torch, vllm
print("  vllm ", vllm.__version__)
print("  torch", torch.__version__, "| cuda", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "no-gpu")
PY

echo "[legion] warming base model cache: $BASE_MODEL"
python - "$BASE_MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
path = snapshot_download(sys.argv[1])
print("  cached at", path)
PY

mkdir -p /srv/adapters
echo "[legion] bootstrap complete."
echo "         Adapters go in /srv/adapters/<name>/lora ; launch with serve-vllm.sh"
