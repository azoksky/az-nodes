ensure_full_env_for_ssh() {
  # If we can't write under /etc (non-root), skip gracefully
  if [ ! -w /etc ]; then
    return 0
  fi

  local env_file="/etc/rp_environment"
  local need_generate=0
  [ ! -s "$env_file" ] && need_generate=1

  if [ "$need_generate" -eq 1 ]; then
    local tmp_file
    tmp_file="$(mktemp "${env_file}.XXXXXX")"

    # Vars we never want to persist (volatile/noisy)
    local exclude='^(PWD|OLDPWD|SHLVL|_|LS_COLORS|SSH_CLIENT|SSH_CONNECTION|SSH_TTY|TERM|HOME|SHELL)$'

    # Read the *original* container environment from PID 1
    if [ -r /proc/1/environ ]; then
      tr '\0' '\n' < /proc/1/environ | while IFS= read -r line; do
        [ -z "$line" ] && continue
        name="${line%%=*}"; value="${line#*=}"
        [[ "$name" =~ $exclude ]] && continue
        # Only set if missing when sourced later
        printf 'if [ -z "${%s+x}" ]; then export %s=%q; fi\n' "$name" "$name" "$value" >> "$tmp_file"
      done
    else
      # Fallback to current env if /proc/1/environ unavailable
      env | while IFS= read -r line; do
        [ -z "$line" ] && continue
        name="${line%%=*}"; value="${line#*=}"
        [[ "$name" =~ $exclude ]] && continue
        printf 'if [ -z "${%s+x}" ]; then export %s=%q; fi\n' "$name" "$name" "$value" >> "$tmp_file"
      done
    fi

    awk '!seen[$0]++' "$tmp_file" > "${tmp_file}.dedup"
    mv -f "${tmp_file}.dedup" "$env_file"
    rm -f "$tmp_file" || true
    chmod 600 "$env_file"
  fi

  # Ensure login/interactive shells source it (idempotent)
  for f in ~/.bashrc ~/.bash_profile ~/.profile; do
    [ -f "$f" ] || touch "$f"
    grep -qxF 'source /etc/rp_environment' "$f" || echo 'source /etc/rp_environment' >> "$f"
  done

  # Also for shells that read /etc/profile.d
  if [ -d /etc/profile.d ] && [ ! -f /etc/profile.d/10-full-env.sh ]; then
    echo '[ -f /etc/rp_environment ] && . /etc/rp_environment' > /etc/profile.d/10-full-env.sh
    chmod 0644 /etc/profile.d/10-full-env.sh
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
