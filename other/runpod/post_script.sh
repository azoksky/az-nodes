#!/usr/bin/env bash
set -Eeuo pipefail

ensure_full_env_for_ssh() {
  if [ ! -w /etc ]; then
    return 0
  fi

  local env_file="/etc/rp_environment"
  if [ ! -s "$env_file" ]; then
    local tmp_file
    tmp_file="$(mktemp "${env_file}.XXXXXX")"

    if [ -r /proc/1/environ ]; then
      tr '\0' '\n' < /proc/1/environ | awk '{
        name=$0; sub(/=.*/, "", name);
        val=$0; sub(/^[^=]*=/, "", val);
        gsub(/\\/, "\\\\", val); gsub(/"/, "\\\"", val);
        printf("if [ -z \"${%s+x}\" ]; then export %s=\"%s\"; fi\n", name, name, val)
      }' > "$tmp_file"
    else
      env | awk '{
        name=$0; sub(/=.*/, "", name);
        val=$0; sub(/^[^=]*=/, "", val);
        gsub(/\\/, "\\\\", val); gsub(/"/, "\\\"", val);
        printf("if [ -z \"${%s+x}\" ]; then export %s=\"%s\"; fi\n", name, name, val)
      }' > "$tmp_file"
    fi

    awk '!seen[$0]++' "$tmp_file" > "${tmp_file}.dedup"
    mv -f "${tmp_file}.dedup" "$env_file"
    rm -f "$tmp_file" || true
    chmod 600 "$env_file"
  fi

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
