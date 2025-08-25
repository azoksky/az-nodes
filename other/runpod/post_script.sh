#!/usr/bin/env bash
set -Eeuo pipefail

PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/main/other/runpod/prepare_comfy.py"
PY_DEST="/tmp/prepare_comfy.py"
LOG_DIR="/workspace"  # fallback to /tmp if /workspace not writable
[[ -w "$LOG_DIR" ]] || LOG_DIR="/tmp"
LOG_FILE="$LOG_DIR/prepare_comfy_$(date +%F_%H-%M-%S).log"

echo "[post_script] Downloading: $PY_URL"
curl -fsSL "$PY_URL" -o "$PY_DEST"
sed -i 's/\r$//' "$PY_DEST"   # just in case

echo "[post_script] Executing: $PY_DEST"
export PYTHONUNBUFFERED=1
# -u = unbuffered; tee shows live output and saves a log
python3 -u "$PY_DEST" "$@" 2>&1 | tee -a "$LOG_FILE"

echo "[post_script] Exit code: ${PIPESTATUS[0]}"
echo "[post_script] Log: $LOG_FILE"
