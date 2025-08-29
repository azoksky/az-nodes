#!/usr/bin/env bash
set -Eeuo pipefail

ensure_full_env_for_ssh() {
  [ -w /etc ] || return 0

  local env_file="/etc/rp_environment"
  local tmp; tmp="$(mktemp "${env_file}.XXXXXX")"

  local src="/proc/1/environ"
  [ -r "$src" ] || src="/proc/self/environ"

  tr '\0' '\n' < "$src" | awk '{
    name=$0; sub(/=.*/, "", name);
    val=$0; sub(/^[^=]*=/, "", val);
    gsub(/\\/, "\\\\", val); gsub(/"/, "\\\"", val);
    printf("if [ -z \"${%s+x}\" ]; then export %s=\"%s\"; fi\n", name, name, val)
  }' > "$tmp"

  awk '!seen[$0]++' "$tmp" > "${tmp}.dedup"
  if ! cmp -s "${tmp}.dedup" "$env_file"; then
    mv -f "${tmp}.dedup" "$env_file"
    chmod 600 "$env_file"
  else
    rm -f "${tmp}.dedup"
  fi
  rm -f "$tmp" || true

  for f in ~/.bashrc ~/.bash_profile ~/.profile; do
    [ -f "$f" ] || touch "$f"
    grep -qxF 'source /etc/rp_environment' "$f" || echo 'source /etc/rp_environment' >> "$f"
  done

  if [ -d /etc/profile.d ] && [ ! -f /etc/profile.d/10-container-env.sh ]; then
    echo '[ -f /etc/rp_environment ] && . /etc/rp_environment' > /etc/profile.d/10-container-env.sh
    chmod 0644 /etc/profile.d/10-container-env.sh
  fi
}


COMFYUI_PATH="${COMFYUI_PATH:-/workspace/ComfyUI}"
WORKSPACE="$(dirname "$COMFYUI_PATH")"
PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"
PY_DEST="$WORKSPACE/prepare_comfy.py"

ensure_full_env_for_ssh
curl -fsSL "$PY_URL" -o "$PY_DEST"
sed -i 's/\r$//' "$PY_DEST"

if [ "$$" -eq 1 ]; then
  exec python3 -u "$PY_DEST" "$@"
else
  python3 -u "$PY_DEST" "$@"
fi
