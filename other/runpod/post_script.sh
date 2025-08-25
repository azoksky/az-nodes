#!/bin/bash
set -e

PY_URL="https://raw.githubusercontent.com/azoksky/az-nodes/main/other/runpod/prepare_comfy.py"
PY_DEST="/tmp/prepare_comfy.py"

echo "Downloading prepare_comfy.py from $PY_URL"
curl -fsSL "$PY_URL" -o "$PY_DEST"

if [[ -s "$PY_DEST" ]]; then
    echo "Executing prepare_comfy.py ..."
    python3 "$PY_DEST"
else
    echo "Download failed or file is empty!"
    exit 1
fi
