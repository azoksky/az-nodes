#!/bin/bash
set -euo pipefail

PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/main/other/runpod/prepare_comfy.py"
PY_DEST="/tmp/prepare_comfy.py"

echo "Downloading prepare_comfy.py from $PY_URL"
curl -fsSL "$PY_URL" -o "$PY_DEST"

# strip CRLF if present
sed -i 's/\r$//' "$PY_DEST"

echo "Executing prepare_comfy.py ..."
python3 "$PY_DEST"

