# -*- coding: utf-8 -*-
import os, json, shutil, urllib.request, pathlib, re, time
from urllib.parse import urlparse, urlunparse
from uuid import uuid4
from subprocess import Popen, DEVNULL
from aiohttp import web
from server import PromptServer

ARIA2_SECRET = os.environ.get("COMFY_ARIA2_SECRET", "comfyui_aria2_secret")
ARIA2_RPC_URL = os.environ.get("COMFY_ARIA2_RPC", "http://127.0.0.1:6800/jsonrpc")
ARIA2_BIN = shutil.which("aria2c") or "aria2c"
RPC_START_ARGS = [
    ARIA2_BIN,
    "--enable-rpc=true",
    "--rpc-listen-all=false",
    f"--rpc-secret={ARIA2_SECRET}",
    "--daemon=true",
    "--console-log-level=error",
    "--disable-ipv6=true",
]

def _aria2_rpc(method, params=None):
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid4()),
        "method": f"aria2.{method}",
        "params": [f"token:{ARIA2_SECRET}"] + (params or []),
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ARIA2_RPC_URL, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _ensure_aria2_daemon():
    try:
        _aria2_rpc("getVersion")
        return
    except Exception:
        pass
    if not shutil.which(ARIA2_BIN):
        raise RuntimeError("aria2c not found in PATH. Please install aria2c.")
    Popen(RPC_START_ARGS, stdout=DEVNULL, stderr=DEVNULL)
    t0 = time.time()
    while time.time() - t0 < 3.0:
        try:
            _aria2_rpc("getVersion")
            return
        except Exception:
            time.sleep(0.15)
    _aria2_rpc("getVersion")

# ---- Directory listing for dropdown ----
def _safe_expand(path_str: str) -> str:
    return os.path.abspath(os.path.expanduser(path_str or ""))

def _listdir(path: str):
    p = pathlib.Path(_safe_expand(path))
    if not p.exists(): raise FileNotFoundError("Path does not exist")
    if not p.is_dir(): raise NotADirectoryError("Not a directory")
    folders, files = [], []
    for entry in p.iterdir():
        try:
            if entry.is_dir(): folders.append(entry.name)
            else: files.append(entry.name)
        except PermissionError:
            continue
    folders.sort(); files.sort()
    return folders, files

@PromptServer.instance.routes.get("/aria2/suggest")
async def aria2_suggest(request: web.Request):
    qpath = request.query.get("prefix", "") or ""
    try:
        abs_root = _safe_expand(qpath)
        sep = os.sep
        folders, files = _listdir(abs_root)
        def make_entries(names):
            return [{"name": n, "path": os.path.join(abs_root, n)} for n in names]
        return web.json_response({
            "ok": True,
            "root": abs_root,
            "sep": sep,
            "folders": make_entries(folders),
            "files": make_entries(files),
        })
    except Exception as e:
        return web.json_response({
            "ok": False,
            "error": str(e),
            "root": _safe_expand(qpath),
            "folders": [],
            "files": [],
        }, status=200)

# ========= API endpoints =========
@PromptServer.instance.routes.post("/aria2/start")
async def aria2_start(request):
    body = await request.json()
    url = (body.get("url") or "").strip()
    dest_dir = _safe_expand(body.get("dest_dir") or os.getcwd())
    if not url:
        return web.json_response({"error": "URL is required."}, status=400)
    try: os.makedirs(dest_dir, exist_ok=True)
    except Exception as e: return web.json_response({"error": f"Cannot access destination: {e}"}, status=400)
    if not os.path.isdir(dest_dir) or not os.access(dest_dir, os.W_OK):
        return web.json_response({"error": f"Destination not writable: {dest_dir}"}, status=400)
    try: _ensure_aria2_daemon()
    except Exception as e: return web.json_response({"error": str(e)}, status=500)

    opts = {
        "continue": "true", "max-connection-per-server": "16", "split": "16",
        "dir": dest_dir, "auto-file-renaming": "true", "remote-time": "true",
        "content-disposition-default-utf8": "true", "header": [
            "Accept: */*", "Accept-Language: en-US,en;q=0.9",
            "User-Agent: Mozilla/5.0"
        ], "max-tries": "5",
    }
    try:
        res = _aria2_rpc("addUri", [[url], opts])
        gid = res.get("result")
        if not gid:
            return web.json_response({"error": "aria2c did not return a gid."}, status=500)
        return web.json_response({"gid": gid, "dest_dir": dest_dir})
    except Exception as e:
        return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)

@PromptServer.instance.routes.get("/aria2/status")
async def aria2_status(request):
    gid = request.query.get("gid", "")
    if not gid: return web.json_response({"error": "gid is required."}, status=400)
    try:
        res = _aria2_rpc("tellStatus", [gid, ["status","totalLength","completedLength","downloadSpeed","errorMessage","files","dir"]])
        st = res.get("result", {})
    except Exception as e:
        return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)
    status = st.get("status", "unknown")
    total = int(st.get("totalLength", "0") or "0")
    done = int(st.get("completedLength", "0") or "0")
    speed = int(st.get("downloadSpeed", "0") or "0")
    percent = (done/total*100.0) if total>0 else 0.0
    return web.json_response({
        "status": status, "percent": round(percent,2),
        "completedLength": done, "totalLength": total,
        "downloadSpeed": speed, "eta": None
    })

@PromptServer.instance.routes.post("/aria2/stop")
async def aria2_stop(request):
    body = await request.json()
    gid = (body.get("gid") or "").strip()
    if not gid: return web.json_response({"error": "gid is required."}, status=400)
    try: _aria2_rpc("remove", [gid]); return web.json_response({"ok": True})
    except Exception as e: return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)

class Aria2Downloader:
    @classmethod
    def INPUT_TYPES(cls): return {"required": {}}
    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"
    def noop(self): return ()
