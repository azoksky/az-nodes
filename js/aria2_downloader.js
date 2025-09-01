# -*- coding: utf-8 -*-
import os
import re
import json
import time
import shutil
import urllib.request
import urllib.parse
from urllib.parse import urlparse, urlunparse
from uuid import uuid4
from subprocess import Popen, DEVNULL

from aiohttp import web
from server import PromptServer

# ========= Config =========
ARIA2_SECRET = os.environ.get("COMFY_ARIA2_SECRET", "comfyui_aria2_secret")
HF_TOKEN = os.environ.get("HF_READ_TOKEN", "")
CIVIT_TOKEN = os.environ.get("CIVIT_TOKEN", "")
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

# ========= RPC helper =========
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
    _aria2_rpc("getVersion")  # raise if still not up

# ========= Filename helpers =========
_SANITIZE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1F]')

def _sanitize_filename(name: str) -> str:
    return _SANITIZE_RE.sub("_", name).strip()

def _safe_expand(path_str: str) -> str:
    return os.path.abspath(os.path.expanduser(path_str or ""))

def _parse_cd_filename(cd: str):
    if not cd:
        return None
    # RFC 5987: filename*=UTF-8''percent-encoded
    m = re.search(r"filename\*\s*=\s*[^'\";]+''([^;]+)", cd, flags=re.IGNORECASE)
    if m:
        try:
            decoded = urllib.parse.unquote(m.group(1))
            n = _sanitize_filename(os.path.basename(decoded))
            return n or None
        except Exception:
            pass
    # filename="name"
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, flags=re.IGNORECASE)
    if m:
        n = _sanitize_filename(os.path.basename(m.group(1)))
        return n or None
    # filename=name
    m = re.search(r'filename\s*=\s*([^;]+)', cd, flags=re.IGNORECASE)
    if m:
        n = _sanitize_filename(os.path.basename(m.group(1).strip()))
        return n or None
    return None

def _origin_from_url(u: str) -> str:
    try:
        p = urlparse(u)
        return urlunparse((p.scheme, p.netloc, "/", "", "", ""))
    except Exception:
        return ""

def _extract_query_filename(u: str):
    try:
        q = urllib.parse.parse_qs(urlparse(u).query)
        for key in ("filename", "file", "name", "response-content-disposition"):
            if key in q and q[key]:
                candidate = q[key][0]
                if key == "response-content-disposition":
                    n = _parse_cd_filename(candidate)
                    if n:
                        return n
                n = _sanitize_filename(os.path.basename(candidate))
                if n:
                    return n
    except Exception:
        pass
    return None

def _head_follow(url: str, max_redirects: int = 5, token: str | None = None):
    opener = urllib.request.build_opener()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, method="HEAD", headers=headers)
    try:
        return opener.open(req, timeout=10)
    except urllib.error.HTTPError as e:
        if e.code in (403, 405):
            req_get = urllib.request.Request(url, method="GET", headers=headers)
            return opener.open(req_get, timeout=10)
        raise

def _smart_guess_filename(url: str, token: str | None = None):
    # 1) Query param hints
    qn = _extract_query_filename(url)
    if qn:
        return (qn, True)
    # 2) HEAD/GET headers
    try:
        resp = _head_follow(url, token=token)
        cd = resp.headers.get("Content-Disposition") or resp.headers.get("content-disposition")
        n = _parse_cd_filename(cd) if cd else None
        if n:
            return (n, True)
    except Exception:
        pass
    # 3) URL path (not confident)
    try:
        path_name = os.path.basename(urlparse(url).path)
        path_name = _sanitize_filename(path_name)
        if path_name:
            return (path_name, False)
    except Exception:
        pass
    return (None, False)

def _eta(total_len, done_len, speed):
    try:
        total = int(total_len); done = int(done_len); spd = max(int(speed), 1)
        remain = max(total - done, 0)
        return remain // spd
    except Exception:
        return None

# ========= API routes =========
@PromptServer.instance.routes.post("/aria2/start")
async def aria2_start(request):
    body = await request.json()
    url = (body.get("url") or "").strip()
    dest_dir = _safe_expand(body.get("dest_dir") or os.getcwd())
    token = (body.get("token") or "").strip()

    if not url:
        return web.json_response({"error": "URL is required."}, status=400)

    # Determine token if not provided
    if not token:
        lower = url.lower()
        if ("huggingface.co" in lower) or ("cdn-lfs.huggingface.co" in lower):
            token = HF_TOKEN
        elif "civitai.com" in lower:
            token = CIVIT_TOKEN

    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        return web.json_response({"error": f"Cannot access destination: {e}"}, status=400)
    if not os.path.isdir(dest_dir) or not os.access(dest_dir, os.W_OK):
        return web.json_response({"error": f"Destination not writable: {dest_dir}"}, status=400)

    try:
        _ensure_aria2_daemon()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    guessed_name, confident = _smart_guess_filename(url, token=token)

    opts = {
        "continue": "true",
        "max-connection-per-server": "16",
        "split": "16",
        "dir": dest_dir,
        "auto-file-renaming": "true",
        "remote-time": "true",
        "content-disposition-default-utf8": "true",
        "header": [
            "Accept: */*",
            "Accept-Language: en-US,en;q=0.9",
            "User-Agent: Mozilla/5.0"
        ],
        "max-tries": "5",
    }
    if token:
        opts["header"].append(f"Authorization: Bearer {token}")
    origin = _origin_from_url(url)
    if origin:
        opts["referer"] = origin
    if confident and guessed_name:
        opts["out"] = guessed_name

    try:
        res = _aria2_rpc("addUri", [[url], opts])
        gid = res.get("result")
        if not gid:
            return web.json_response({"error": "aria2c did not return a gid."}, status=500)
        return web.json_response({
            "gid": gid,
            "dest_dir": dest_dir,
            "guessed_out": opts.get("out", "") or "",
            "confident": bool(confident),
        })
    except Exception as e:
        return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)

@PromptServer.instance.routes.get("/aria2/status")
async def aria2_status(request):
    gid = request.query.get("gid", "")
    if not gid:
        return web.json_response({"error": "gid is required."}, status=400)
    try:
        res = _aria2_rpc("tellStatus", [gid, ["status", "totalLength", "completedLength", "downloadSpeed", "errorMessage", "files", "dir"]])
        st = res.get("result", {})
    except Exception as e:
        return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)
    status = st.get("status", "unknown")
    total = int(st.get("totalLength", "0") or "0")
    done = int(st.get("completedLength", "0") or "0")
    speed = int(st.get("downloadSpeed", "0") or "0")
    percent = (done / total * 100.0) if total > 0 else (100.0 if status == "complete" else 0.0)

    filepath = ""
    filename = ""
    files = st.get("files") or []
    if files:
        fp = files[0].get("path") or ""
        if fp:
            filepath = fp
            filename = os.path.basename(fp)
    if not filepath and st.get("dir") and filename:
        filepath = os.path.join(st["dir"], filename)

    out = {
        "status": status,
        "percent": round(percent, 2),
        "completedLength": done,
        "totalLength": total,
        "downloadSpeed": speed,
        "eta": _eta(total, done, speed),
        "filename": filename,
        "filepath": filepath,
    }
    if status == "error":
        out["error"] = st.get("errorMessage", "unknown error")
    return web.json_response(out)

@PromptServer.instance.routes.post("/aria2/stop")
async def aria2_stop(request):
    body = await request.json()
    gid = (body.get("gid") or "").strip()
    if not gid:
        return web.json_response({"error": "gid is required."}, status=400)
    try:
        _aria2_rpc("remove", [gid])
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"error": f"aria2c RPC error: {e}"}, status=500)

@PromptServer.instance.routes.get("/az/listdir")
async def az_listdir(request):
    raw = request.query.get("path", "")
    base = _safe_expand(raw)
    if not base:
        return web.json_response({"ok": True, "root": "", "folders": []})

    root = base
    if not os.path.isdir(root):
        parent = os.path.dirname(root)
        root = parent or base

    folders = []
    try:
        for name in sorted(os.listdir(root)):
            full = os.path.join(root, name)
            if os.path.isdir(full):
                folders.append({"name": name})
    except Exception:
        pass

    return web.json_response({
        "ok": True,
        "root": root.replace("\\", "/"),
        "folders": folders
    })

@PromptServer.instance.routes.get("/tokens")
async def tokens(request):
    hf_suffix = HF_TOKEN[-4:] if HF_TOKEN and len(HF_TOKEN) >= 4 else HF_TOKEN or ""
    civit_suffix = CIVIT_TOKEN[-4:] if CIVIT_TOKEN and len(CIVIT_TOKEN) >= 4 else CIVIT_TOKEN or ""
    return web.json_response({"hf": hf_suffix, "civit": civit_suffix})

@PromptServer.instance.routes.get("/tokens/resolve")
async def tokens_resolve(request):
    """Return the appropriate token for a given URL, so the UI can auto-fill."""
    url = (request.query.get("url") or "").lower()
    token = ""
    kind = ""
    if ("huggingface.co" in url) or ("cdn-lfs.huggingface.co" in url):
        token = HF_TOKEN
        kind = "hf"
    elif "civitai.com" in url:
        token = CIVIT_TOKEN
        kind = "civit"
    return web.json_response({"token": token or "", "kind": kind})

# ========= UI-only node =========
class Aria2Downloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()
