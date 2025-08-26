import os
import re
import json
import time
import asyncio
import aiofiles
import aiohttp
from uuid import uuid4
from typing import Dict, Any
from concurrent.futures import ThreadPoolExecutor
import threading
import weakref

from aiohttp import web
from server import PromptServer
from huggingface_hub import HfApi, hf_hub_download

# ========= Progress store with automatic cleanup =========
_downloads: Dict[str, Dict[str, Any]] = {}
_stop_flags: Dict[str, bool] = {}
_cleanup_lock = threading.Lock()

# Thread pool for non-blocking operations
_executor = ThreadPoolExecutor(max_workers=3, thread_name_prefix="hf_download")

_SANITIZE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1F]')

def _sanitize_filename(name: str) -> str:
    return _SANITIZE_RE.sub("_", name).strip()

def _eta(total, done, speed):
    if speed and speed > 0 and total and done is not None:
        rem = max(0, total - done)
        return int(rem / speed)
    return None

def _cleanup_download(gid: str):
    """Thread-safe cleanup of download resources"""
    with _cleanup_lock:
        _downloads.pop(gid, None)
        _stop_flags.pop(gid, None)

def _schedule_cleanup(gid: str, delay: float = 10.0):
    """Schedule cleanup after delay"""
    def delayed_cleanup():
        time.sleep(delay)
        _cleanup_download(gid)
    
    thread = threading.Thread(target=delayed_cleanup, daemon=True)
    thread.start()

# ========= Async download function using hf_hub_download =========
async def _download_file_async(gid: str, repo_id: str, filename: str, dest_dir: str, token: str = None):
    """Async download function using hf_hub_download"""
    info = _downloads[gid]
    final_path = os.path.join(dest_dir, _sanitize_filename(filename))
    info["filepath"] = final_path

    try:
        # Get file info to set total size
        def get_file_info():
            api = HfApi(token=token) if token else HfApi()
            try:
                file_info = api.file_metadata(repo_id=repo_id, repo_type="model", path_in_repo=filename)
                return int(file_info.size or 0)
            except Exception:
                return 0
        
        total = await asyncio.get_event_loop().run_in_executor(_executor, get_file_info)
        info["totalLength"] = total
        info["status"] = "active"

        # Progress callback for hf_hub_download
        def progress_callback(downloaded: int, total_size: int):
            if _stop_flags.get(gid, False):
                raise asyncio.CancelledError("Download stopped by user")
            
            now = time.time()
            info["completedLength"] = downloaded
            if total_size > 0:
                info["percent"] = min(100.0, (downloaded / total_size) * 100.0)
            
            # Update speed and ETA every 500ms
            if not hasattr(info, "last_update"):
                info["last_update"] = now
                info["last_downloaded"] = 0
            if now - info["last_update"] >= 0.5:
                dt = now - info["last_update"]
                speed = (downloaded - info["last_downloaded"]) / dt
                info["downloadSpeed"] = int(speed)
                info["eta"] = _eta(total_size, downloaded, speed)
                info["last_update"] = now
                info["last_downloaded"] = downloaded

        # Run hf_hub_download in thread pool to avoid blocking event loop
        def download_file():
            return hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                local_dir=dest_dir,
                local_dir_use_symlinks=False,
                token=token,
                progress_callback=progress_callback
            )

        await asyncio.get_event_loop().run_in_executor(_executor, download_file)
        
        info["status"] = "complete"
        info["percent"] = 100.0

    except asyncio.CancelledError:
        info["status"] = "stopped"
        # Clean up partial download
        if os.path.exists(final_path):
            try:
                os.remove(final_path)
            except:
                pass
    except Exception as e:
        info["status"] = "error"
        info["error"] = str(e)
        if os.path.exists(final_path):
            try:
                os.remove(final_path)
            except:
                pass
    finally:
        # Schedule cleanup
        _schedule_cleanup(gid)

# Store active download tasks
_active_tasks: Dict[str, asyncio.Task] = {}

# ========= Routes =========
@PromptServer.instance.routes.post("/hf/start")
async def hf_start(request):
    try:
        body = await request.json()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
        
    repo_id = (body.get("repo_id") or "").strip()
    filename = (body.get("filename") or "").strip()
    dest_dir = (body.get("dest_dir") or os.getcwd()).strip()
    
    if not repo_id or not filename:
        return web.json_response({"error": "repo_id and filename are required."}, status=400)
    
    # Validate destination directory
    try:
        os.makedirs(dest_dir, exist_ok=True)
        if not os.access(dest_dir, os.W_OK):
            return web.json_response({"error": "Destination directory is not writable"}, status=400)
    except Exception as e:
        return web.json_response({"error": f"Cannot access destination: {e}"}, status=400)

    gid = uuid4().hex
    token = os.environ.get("HF_READ_TOKEN") or os.environ.get("HF_TOKEN")

    # Initialize download info
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
        "start_time": time.time()
    }
    
    _downloads[gid] = info
    _stop_flags[gid] = False

    # Start download task
    task = asyncio.create_task(_download_file_async(gid, repo_id, filename, dest_dir, token))
    _active_tasks[gid] = task
    
    # Clean up task when done
    def cleanup_task(task):
        _active_tasks.pop(gid, None)
    task.add_done_callback(cleanup_task)
    
    return web.json_response({
        "gid": gid, 
        "dest_dir": dest_dir, 
        "guessed_out": filename, 
        "confident": True
    })

@PromptServer.instance.routes.get("/hf/status")
async def hf_status(request):
    gid = request.query.get("gid")
    if not gid:
        return web.json_response({"error": "gid parameter required"}, status=400)
    
    with _cleanup_lock:
        if gid not in _downloads:
            return web.json_response({"error": "unknown gid"}, status=404)
        info = _downloads[gid].copy()  # Copy to avoid race conditions
    
    # Build response
    out = {
        "status": info.get("status", "unknown"),
        "percent": round(float(info.get("percent", 0.0)), 2),
        "completedLength": int(info.get("completedLength", 0)),
        "totalLength": int(info.get("totalLength", 0)),
        "downloadSpeed": int(info.get("downloadSpeed", 0)),
        "eta": info.get("eta"),
        "filename": info.get("filename", ""),
        "filepath": info.get("filepath", ""),
    }
    
    if info.get("status") == "error" and info.get("error"):
        out["error"] = info["error"]
    
    return web.json_response(out)

@PromptServer.instance.routes.post("/hf/stop")
async def hf_stop(request):
    try:
        body = await request.json()
        gid = (body.get("gid") or "").strip()
    except:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    
    if not gid:
        return web.json_response({"error": "gid is required"}, status=400)
    
    # Set stop flag
    _stop_flags[gid] = True
    
    # Cancel active task if it exists
    task = _active_tasks.get(gid)
    if task and not task.done():
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
    
    return web.json_response({"ok": True})

# ========= UI-only node =========
class hf_hub_downloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "AZ_Nodes"

    def noop(self):
        return ()
