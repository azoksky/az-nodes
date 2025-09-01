import os
import json
import threading
from uuid import uuid4
from typing import Dict, Any

from aiohttp import web
from server import PromptServer
from huggingface_hub import hf_hub_download

# ============ minimal job store ============
_downloads: Dict[str, Dict[str, Any]] = {}

def _set(gid: str, **kw):
    _downloads.setdefault(gid, {})
    _downloads[gid].update(kw)

def _get(gid: str, key: str, default=None):
    return _downloads.get(gid, {}).get(key, default)

# ============ worker ============
def _worker(gid: str, repo_id: str, filename: str, dest_dir: str, token: str | None):
    try:
        _set(gid, state="running", msg="Download started…", filepath=None)
        local_path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=dest_dir,
            token=token
        )
        _set(gid, state="done", msg="File download complete.", filepath=local_path)
    except Exception as e:
        _set(gid, state="error", msg=f"{type(e).__name__}: {e}")

# ============ routes ============
async def start_download(request: web.Request):
    try:
        data = await request.json()
        repo_id = (data.get("repo_id") or "").strip()
        filename = (data.get("filename") or "").strip()
        dest_dir = (data.get("dest_dir") or "").strip()
        token = (data.get("token_input") or "").strip() or os.environ.get("HF_READ_TOKEN", "")

        if not repo_id or not filename or not dest_dir:
            return web.json_response({"ok": False, "error": "repo_id, filename, dest_dir are required"}, status=400)

        os.makedirs(dest_dir, exist_ok=True)

        gid = data.get("gid") or uuid4().hex
        _downloads[gid] = {
            "state": "starting",
            "msg": "Starting…",
            "filepath": None,
            "cancel": False,
            "thread": None,
        }

        t = threading.Thread(target=_worker, args=(gid, repo_id, filename, dest_dir, token), daemon=True)
        _downloads[gid]["thread"] = t
        t.start()

        return web.json_response({"ok": True, "gid": gid, "state": "running", "msg": "Download started…"})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

async def status_download(request: web.Request):
    gid = request.query.get("gid", "")
    if gid not in _downloads:
        return web.json_response({"ok": False, "error": "unknown gid"}, status=404)
    info = _downloads[gid]
    return web.json_response({
        "ok": True,
        "gid": gid,
        "state": info.get("state", "unknown"),
        "msg": info.get("msg", ""),
        "filepath": info.get("filepath"),
    })

async def stop_download(request: web.Request):
    try:
        data = await request.json()
        gid = (data.get("gid") or "").strip()
        if gid not in _downloads:
            return web.json_response({"ok": False, "error": "unknown gid"}, status=404)
        info = _downloads[gid]
        t: threading.Thread | None = info.get("thread")
        if t and t.is_alive():
            _set(gid, state="stopped", msg="Stop requested by user.")
        else:
            _set(gid, state="stopped", msg="Already finished.")
        return web.json_response({"ok": True, "gid": gid, "state": _get(gid, "state"), "msg": _get(gid, "msg")})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"{type(e).__name__}: {e}"}, status=500)

# ============ register with ComfyUI ============
def _register_routes():
    app = PromptServer.instance.app
    app.router.add_post("/hf/start", start_download)
    app.router.add_get("/hf/status", status_download)
    app.router.add_post("/hf/stop", stop_download)

_register_routes()

# ============ UI node shell ============
class hf_hub_downloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}
    RETURN_TYPES = []
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"
    def noop(self):
        return ()
