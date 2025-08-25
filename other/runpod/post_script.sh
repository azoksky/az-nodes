#!/usr/bin/env bash
set -Eeuo pipefail

# Allow override with env var if needed
PY_URL="${PREPARE_PY_URL:-https://raw.githubusercontent.com/azoksky/az-nodes/main/other/runpod/prepare_comfy.py}"
PY_DEST="/tmp/prepare_comfy.py"

echo "[post_script] Downloading: $PY_URL"
curl -fsSL --connect-timeout 20 --max-time 600 "$PY_URL" -o "$PY_DEST"

# In case the Python file was authored on Windows, normalize it
# (this runs AFTER bash has already parsed this script)
sed -i 's/\r$//' "$PY_DEST"

# Optional: make sure HF cache points at /workspace if you want
# export HF_HOME=/workspace/.cache/huggingface
# export TRANSFORMERS_CACHE=$HF_HOME
# export HF_HUB_CACHE=$HF_HOME

echo "[post_script] Executing: $PY_DEST"
python3 "$PY_DEST"
echo "[post_script] Done."
