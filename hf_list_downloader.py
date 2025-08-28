# hf_list_downloader.py
# -*- coding: utf-8 -*-
import os
import json
import shutil
from pathlib import Path
from typing import List, Tuple

from aiohttp import web
from server import PromptServer
from huggingface_hub import hf_hub_download
import urllib.request
from urllib.error import URLError, HTTPError

# ---------- Paths & env ----------
COMFY     = Path(os.environ.get("COMFYUI_PATH", "./ComfyUI")).resolve()
WORKSPACE = COMFY.parent.resolve()
MODELS    = Path(os.environ.get("COMFYUI_MODEL_PATH", str(COMFY / "models"))).resolve()
HF_TOKEN  = os.environ.get("HF_READ_TOKEN") or None

# Default list URL; can be overridden by env var DOWNLOAD_LIST
LIST_URL_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/download_list.txt"
LIST_URL_ENV = (os.environ.get("DOWNLOAD_LIST") or "").strip() or LIST_URL_DEFAULT

# ---------- Helpers ----------
def _clean_parts(line: str) -> Tuple[str, str, str] | None:
    # Expect exactly 3 parts: repo_id, file_in_repo, local_subdir
    parts = [x.strip() for x in line.split(",", 2)]
    if len(parts) != 3:
        return None
    a, b, c = parts
    if not a or not b or not c:
        return None
    return (a, b, c)

def _read_list_file(p: Path):
    if not p.is_file():
        raise FileNotFoundError(f"No download list found at {p}")
    out = []
    with p.open("r", encoding="utf-8") as f:
        for raw in f:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            tup = _clean_parts(s)
            if tup:
                out.append(tup)
    return out

def _atomic_fetch(url: str, dest: Path, timeout: int = 30, attempts: int = 3) -> bool:
    """Download URL to dest atomically with small retry."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    for i in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            tmp.replace(dest)
            return True
        except Exception:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
    return False

def _resolve_requested_path(relish: str) -> Path:
    """If the user passes a bare 'download_list.txt', prefer WORKSPACE/ that file."""
    p = (Path(relish).expanduser())
    if p.name == "download_list.txt" and ("/" not in relish and "\\" not in relish):
        return (WORKSPACE / "download_list.txt").resolve()
    return p.resolve()

# ---------- API: read ----------
@PromptServer.instance.routes.get("/hf_list/read")
async def hf_list_read(request):
    # Optional ?path=... (defaults to "download_list.txt", prefer WORKSPACE location)
    relish = (request.query.get("path") or "download_list.txt").strip()
    path = _resolve_requested_path(relish)

    # If path doesn't exist and looks like the default name, auto-fetch from URL (env wins)
    if not path.is_file() and path.name == "download_list.txt":
        fetched = _atomic_fetch(LIST_URL_ENV, path)
        if fetched:
            print(f"missing list auto-fetched → {path}")

    try:
        items = _read_list_file(path)
        payload = {
            "ok": True,
            "file": str(path),
            "total": len(items),
            "items": [
                {
                    "id": i + 1,
                    "repo_id": repo,
                    "file_in_repo": file_in_repo,
                    "local_subdir": local_subdir,
                }
                for i, (repo, file_in_repo, local_subdir) in enumerate(items)
            ],
        }
        return web.json_response(payload)
    except FileNotFoundError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=404)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"Failed to read list: {e}"}, status=500)

# ---------- NEW: force-refresh (always fetch from internet & overwrite local) ----------
@PromptServer.instance.routes.post("/hf_list/refresh")
async def hf_list_refresh(request):
    """
    Body:
      { "path": "download_list.txt" }   // path is optional; defaults to WORKSPACE/download_list.txt
    Uses DOWNLOAD_LIST env var if set; otherwise LIST_URL_DEFAULT.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    relish = (body.get("path") or "download_list.txt").strip()
    path = _resolve_requested_path(relish)
    url = LIST_URL_ENV  # env override if present, else default
    ok = _atomic_fetch(url, path)
    if not ok:
        return web.json_response({"ok": False, "error": f"Failed to fetch from {url}"}, status=502)
    return web.json_response({"ok": True, "file": str(path), "url": url})

# ---------- API: download one ----------
@PromptServer.instance.routes.post("/hf_list/download")
async def hf_list_download(request):
    """
    Body:
      {
        "repo_id": "...",
        "file_in_repo": "...",
        "local_subdir": "..."
      }
    """
    body = await request.json()
    repo_id      = (body.get("repo_id") or "").strip()
    file_in_repo = (body.get("file_in_repo") or "").strip()
    local_subdir = (body.get("local_subdir") or "").strip()

    if not repo_id or not file_in_repo or not local_subdir:
        return web.json_response({"ok": False, "error": "Invalid or incomplete line data."}, status=400)

    stage_dir = (WORKSPACE / "_hfstage")
    stage_dir.mkdir(parents=True, exist_ok=True)

    target_dir = (MODELS / local_subdir.strip("/\\"))
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"Cannot create target dir: {e}"}, status=400)

    try:
        downloaded = hf_hub_download(
            repo_id=repo_id,
            filename=file_in_repo,
            token=HF_TOKEN,
            local_dir=str(stage_dir),
        )
        src = Path(downloaded)
        dst = (target_dir / src.name)
        shutil.move(str(src), str(dst))
        try:
            if stage_dir.exists():
                shutil.rmtree(stage_dir, ignore_errors=True)
                print(f"🧹 Cleaned up staging folder: {stage_dir}")
        except Exception as e:
            print(f"⚠ Failed to remove staging folder {stage_dir}: {e}")
        return web.json_response({
            "ok": True,
            "dst": str(dst),
            "repo_id": repo_id,
            "file_in_repo": file_in_repo,
            "local_subdir": local_subdir,
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": f"Download failed: {e}"}, status=500)

class HFListDownloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}  # UI-only

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()
