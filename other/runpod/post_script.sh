#!/usr/bin/env bash
set -Eeuo pipefail

# Workspace location
WORKSPACE="/workspace"

# Ensure workspace exists
mkdir -p "$WORKSPACE"

# URLs
PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"
LIST_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/download_list.txt"

# Destinations
PY_DEST="$WORKSPACE/prepare_comfy.py"
LIST_DEST="$WORKSPACE/download_list.txt"

# Download files
curl -fsSL "$PY_URL"   -o "$PY_DEST"
curl -fsSL "$LIST_URL" -o "$LIST_DEST"

# Normalize line endings (Windows CRLF → Unix LF)
sed -i 's/\r$//' "$PY_DEST"
sed -i 's/\r$//' "$LIST_DEST"

# Run the Python script (so exit code is from Python)
exec python3 -u "$PY_DEST" "$@"
