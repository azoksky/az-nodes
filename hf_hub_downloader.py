import os
import re
import json
import time
import threading
from uuid import uuid4
from typing import Dict, Any

import requests
from aiohttp import web
from server import PromptServer
from huggingface_hub import HfApi, hf_hub_url

# ========= simple progress store =========
_downloads: Dict[str, Dict[str, Any]] = {}
_stop_flags: Dict[str, bool] = {}

_SANITIZE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1F]')

def _sanitize_filename(name: str) -> str:
    return _SANITIZE_RE.sub("_", name).strip()

def _eta(total, done, speed):
    if speed and total and done is not None:
        rem = max(0, total - done)
        return int(rem / max(1, speed))
    return None

# ========= routes =========
@PromptServer.instance.routes.post("/hf/start")
async def hf_start(request):
    body = await request.json()
    repo_id = (body.get("repo_id") or "").strip()
    filename = (body.get("filename") or "").strip()
    dest_dir = (body.get("dest_dir") or os.getcwd()).strip()
    if not repo_id or not filename:
        return web.json_response({"error": "repo_id and filename are required."}, status=400)
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return web.json_response({"error": f"Cannot access destination: {e}"}, status=400)

    gid = uuid4().hex
    token = os.environ.get("hf_read_token") or os.environ.get("HF_TOKEN")

    info = {
        "status": "starting",
        "percent": 0.0,
        "completedLength": 0,
        "totalLength": 0,
        "downloadSpeed": 0,
        "eta": None,
        "filename": filename,
        "filepath": os.path.join(dest_dir, _sanitize_filename(filename)),
        "error": None,
    }
    _downloads[gid] = info
    _stop_flags[gid] = False

    def _worker():
        t0 = time.time()
        last_t, last_done = t0, 0
        try:
            api = HfApi(token=token) if token else HfApi()
            # query size
            try:
                file_info = api.repo_file_info(repo_id=repo_id, path_in_repo=filename)
                total = int(file_info.size or 0)
            except Exception:
                total = 0
            info["totalLength"] = total

            url = hf_hub_url(repo_id=repo_id, filename=filename)
            headers = {"User-Agent": "ComfyUI-HF-Downloader"}
            if token:
                headers["Authorization"] = f"Bearer {token}"

            tmp_path = info["filepath"] + ".part"
            with requests.get(url, headers=headers, stream=True, timeout=60) as r:
                r.raise_for_status()
                info["status"] = "active"
                with open(tmp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 512):  # 512 KiB
                        if _stop_flags.get(gid):
                            info["status"] = "stopped"
                            break
                        if not chunk:
                            continue
                        f.write(chunk)
                        info["completedLength"] += len(chunk)
                        now = time.time()
                        dt = max(1e-6, now - last_t)
                        inc = info["completedLength"] - last_done
                        info["downloadSpeed"] = int(inc / dt)
                        last_t, last_done = now, info["completedLength"]
                        tot = info.get("totalLength") or 0
                        if tot > 0:
                            info["percent"] = round(info["completedLength"] / tot * 100.0, 2)
                        info["eta"] = _eta(tot, info["completedLength"], info["downloadSpeed"])
            # finalize
            if info["status"] == "stopped":
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                return
            # move to final
            try:
                os.replace(tmp_path, info["filepath"])
            except Exception:
                pass
            info["status"] = "complete"
            info["percent"] = 100.0
        except Exception as e:
            info["status"] = "error"
            info["error"] = str(e)

    threading.Thread(target=_worker, daemon=True).start()
    return web.json_response({"gid": gid, "dest_dir": dest_dir, "guessed_out": filename, "confident": True})


@PromptServer.instance.routes.get("/hf/status")
async def hf_status(request):
    gid = request.query.get("gid")
    if not gid or gid not in _downloads:
        return web.json_response({"error": "unknown gid"}, status=400)
    info = _downloads[gid]
    out = {
        "status": info.get("status","unknown"),
        "percent": float(info.get("percent",0.0)),
        "completedLength": int(info.get("completedLength",0)),
        "totalLength": int(info.get("totalLength",0)),
        "downloadSpeed": int(info.get("downloadSpeed",0)),
        "eta": info.get("eta"),
        "filename": info.get("filename",""),
        "filepath": info.get("filepath",""),
    }
    if info.get("status") == "error" and info.get("error"):
        out["error"] = info["error"]
    return web.json_response(out)


@PromptServer.instance.routes.post("/hf/stop")
async def hf_stop(request):
    body = await request.json()
    gid = (body.get("gid") or "").strip()
    if not gid or gid not in _downloads:
        return web.json_response({"error": "unknown gid"}, status=400)
    _stop_flags[gid] = True
    return web.json_response({"ok": True})


# ========= UI-only node =========
class hf_hub_downloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}  # no backend auto-widgets

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()

