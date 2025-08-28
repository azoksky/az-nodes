#!/usr/bin/env bash
set -Eeuo pipefail

# Workspace location
WORKSPACE="${WORKSPACE:-/workspace}"
# Ensure workspace exists
mkdir -p "$WORKSPACE"

# URLs
PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/prepare_comfy.py"

# Destination
PY_DEST="$WORKSPACE/prepare_comfy.py"

# Download files
curl -fsSL "$PY_URL"   -o "$PY_DEST"

# Normalize line endings (Windows CRLF → Unix LF)
sed -i 's/\r$//' "$PY_DEST"

# Run the Python script (so exit code is from Python)
python3 -u "$PY_DEST" "$@"
