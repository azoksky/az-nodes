#!/usr/bin/env bash
set -Eeuo pipefail

export_env_vars_if_missing() {
  if [ ! -w /etc ]; then
    return 0
  fi

  local env_file="/etc/rp_environment"
  local need_generate=0

  if [ ! -f "$env_file" ]; then
    need_generate=1
  elif ! grep -qE '^export RUNPOD_' "$env_file"; then
    need_generate=1
  fi

  if [ "$need_generate" -eq 1 ]; then
    local tmp_file
    tmp_file="$(mktemp "${env_file}.XXXXXX")"
    printenv | grep -E '^RUNPOD_|^PATH=|^_=' \
      | awk -F= '{
          val=$0; sub(/^[^=]*=/,"",val);
          gsub(/\\/,"\\\\",val); gsub(/"/,"\\\"",val);
          printf("export %s=\"%s\"\n",$1,val)
        }' > "$tmp_file"
    awk '!seen[$0]++' "$tmp_file" > "${tmp_file}.dedup"
    mv -f "${tmp_file}.dedup" "$env_file"
    rm -f "$tmp_file" || true
  fi

  for f in ~/.bashrc ~/.bash_profile ~/.profile; do
    [ -f "$f" ] || touch "$f"
    grep -qxF 'source /etc/rp_environment' "$f" || echo 'source /etc/rp_environment' >> "$f"
  done

  if [ -d /etc/profile.d ]; then
    if [ ! -f /etc/profile.d/10-runpod-env.sh ]; then
      echo '[ -f /etc/rp_environment ] && . /etc/rp_environment' > /etc/profile.d/10-runpod-env.sh
      chmod 0644 /etc/profile.d/10-runpod-env.sh
    fi
  fi
}

COMFYUI_PATH="${COMFYUI_PATH:-/workspace/ComfyUI}"
WORKSPACE="$(dirname "$COMFYUI_PATH")"
PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"
PY_DEST="$WORKSPACE/prepare_comfy.py"

export_env_vars_if_missing
curl -fsSL "$PY_URL" -o "$PY_DEST"
sed -i 's/\r$//' "$PY_DEST"

if [ "$$" -eq 1 ]; then
  exec python3 -u "$PY_DEST" "$@"
else
  python3 -u "$PY_DEST" "$@"
fi







# #!/usr/bin/env bash
# set -Eeuo pipefail

# # Workspace location
# WORKSPACE="${WORKSPACE:-/workspace}"
# # Ensure workspace exists
# mkdir -p "$WORKSPACE"

# # URLs
# PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"

# # Destination
# PY_DEST="$WORKSPACE/prepare_comfy.py"

# # Download files
# curl -fsSL "$PY_URL"   -o "$PY_DEST"

# # Normalize line endings (Windows CRLF → Unix LF)
# sed -i 's/\r$//' "$PY_DEST"

# # Run the Python script (so exit code is from Python)
# python3 -u "$PY_DEST" "$@"
