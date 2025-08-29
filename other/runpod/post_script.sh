#!/usr/bin/env bash
set -Eeuo pipefail

ensure_full_env_for_ssh() 
{
tr '\0' '\n' < /proc/1/environ | awk '{
  name=$0; sub(/=.*/, "", name);
  val=$0;  sub(/^[^=]*=/, "", val);
  gsub(/\\/, "\\\\", val); gsub(/"/, "\\\"", val);
  printf("if [ -z \"${%s+x}\" ]; then export %s=\"%s\"; fi\n", name, name, val)
}' > /etc/profile.d/10-container-env.sh
}

ensure_full_env_for_ssh
COMFYUI_PATH="${COMFYUI_PATH:-/workspace/ComfyUI}"
WORKSPACE="$(dirname "$COMFYUI_PATH")"
PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"
PY_DEST="$WORKSPACE/prepare_comfy.py"

curl -fsSL "$PY_URL" -o "$PY_DEST"
sed -i 's/\r$//' "$PY_DEST"

if [ "$$" -eq 1 ]; then
  exec python3 -u "$PY_DEST" "$@"
else
  python3 -u "$PY_DEST" "$@"
fi
