# -*- coding: utf-8 -*-
"""
ComfyUI Path Uploader (UI-only node)
- POST /az/upload : multipart/form-data { file, dest_dir }
- Streams to disk; client shows progress using XHR upload events.
"""
import os
import re
from aiohttp import web
from server import PromptServer

# ---------- helpers ----------
_SAN = re.compile(r'[\\:*?"<>|\x00-\x1F]')  # we allow slashes to keep path
def _safe_expand(p: str) -> str:
    return os.path.abspath(os.path.expanduser(p or ""))

def _safe_filename(name: str) -> str:
    # keep basename safe; leave extension
    base = os.path.basename(name or "")
    return _SAN.sub("_", base) or "upload.bin"

# ---------- routes ----------
@PromptServer.instance.routes.post("/az/upload")
async def az_upload(request: web.Request):
    """
    Form fields:
      - file: binary
      - dest_dir: optional server-side folder (created if missing)
    """
    reader = await request.multipart()

    dest_dir = None
    file_field = None

    # accept fields in any order
    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name == "dest_dir":
            dest_dir_val = (await field.text()) or ""
            dest_dir = _safe_expand(dest_dir_val)
        elif field.name == "file":
            file_field = field

    if file_field is None:
        return web.json_response({"error": "No file part provided"}, status=400)

    # fall back to ./uploads if dest not provided
    if not dest_dir:
        dest_dir = _safe_expand("./uploads")

    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return web.json_response({"error": f"Cannot create destination: {e}"}, status=400)

    if not os.path.isdir(dest_dir) or not os.access(dest_dir, os.W_OK):
        return web.json_response({"error": f"Destination not writable: {dest_dir}"}, status=400)

    filename = _safe_filename(file_field.filename or "upload.bin")
    save_path = os.path.join(dest_dir, filename)

    # stream to disk
    total = 0
    try:
        with open(save_path, "wb") as f:
            while True:
                chunk = await file_field.read_chunk()  # default 8192
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
    except Exception as e:
        return web.json_response({"error": f"Write failed: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "filename": filename,
        "path": os.path.abspath(save_path),
        "bytes": total
    })

# ---------- node stub ----------
class PathUploader:
    """
    UI-only node; widgets are provided by JS. No queue execution involved.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()

