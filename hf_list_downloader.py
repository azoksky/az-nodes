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

# ---------- Paths & env ----------
COMFY    = Path(os.environ.get("COMFYUI_PATH", "./ComfyUI")).resolve()
WORKSPACE = COMFY.parent.resolve()
MODELS   = Path(os.environ.get("COMFYUI_MODEL_PATH", str(COMFY / "models"))).resolve()
HF_TOKEN = os.environ.get("HF_READ_TOKEN") or None

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

def _read_list_file(p: Path) -> List[Tuple[str, str, str]]:
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

# ---------- API: read ----------
@PromptServer.instance.routes.get("/hf_list/read")
async def hf_list_read(request):
    # Optional ?path=... (defaults to "download_list.txt" relative to current working dir)
    rel = (request.query.get("path") or "download_list.txt").strip()
    path = Path(rel).expanduser().resolve()
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
    repo_id     = (body.get("repo_id") or "").strip()
    file_in_repo= (body.get("file_in_repo") or "").strip()
    local_subdir= (body.get("local_subdir") or "").strip()

    if not repo_id or not file_in_repo or not local_subdir:
        return web.json_response({"ok": False, "error": "Invalid or incomplete line data."}, status=400)

    # staging directory to keep hub's content neat
    stage_dir = (WORKSPACE / "_hfstage")
    stage_dir.mkdir(parents=True, exist_ok=True)

    # final target directory inside COMFYUI_MODEL_PATH/local_subdir
    target_dir = (MODELS / local_subdir.strip("/\\"))
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"Cannot create target dir: {e}"}, status=400)

    try:
        # Download to staging via huggingface_hub
        downloaded = hf_hub_download(
            repo_id=repo_id,
            filename=file_in_repo,
            token=HF_TOKEN,
            local_dir=str(stage_dir),
        )

        # Move the actual file (basename) into target_dir
        src = Path(downloaded)
        dst = (target_dir / src.name)
        shutil.move(str(src), str(dst))
        # clean up empty parent folders that HF may create inside stage_dir
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
