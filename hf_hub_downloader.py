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
from huggingface_hub import HfApi, hf_hub_url

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

# ========= Async download function =========
async def _download_file_async(gid: str, repo_id: str, filename: str, dest_dir: str, token: str = None):
    """Async download function that doesn't block the event loop"""
    info = _downloads[gid]
    session = None
    tmp_path = None
    
    try:
        # Get file info first
        def get_file_info():
            api = HfApi(token=token) if token else HfApi()
            try:
                file_info = api.repo_file_info(repo_id=repo_id, path_in_repo=filename)
                return int(file_info.size or 0)
            except Exception:
                return 0
        
        # Run file info check in thread pool to avoid blocking
        total = await asyncio.get_event_loop().run_in_executor(_executor, get_file_info)
        info["totalLength"] = total
        
        url = hf_hub_url(repo_id=repo_id, filename=filename)
        headers = {
            "User-Agent": "ComfyUI-HF-Downloader",
            "Accept": "*/*"
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"

        tmp_path = os.path.join(dest_dir, _sanitize_filename(filename) + ".part")
        final_path = os.path.join(dest_dir, _sanitize_filename(filename))
        info["filepath"] = final_path
        
        # Use aiohttp for truly async downloads
        timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            info["status"] = "active"
            
            async with session.get(url) as response:
                response.raise_for_status()
                
                # Track progress
                downloaded = 0
                last_update = time.time()
                last_downloaded = 0
                chunk_size = 1024 * 64  # 64KB chunks
                
                async with aiofiles.open(tmp_path, 'wb') as f:
                    async for chunk in response.content.iter_chunked(chunk_size):
                        # Check stop flag
                        if _stop_flags.get(gid, False):
                            info["status"] = "stopped"
                            break
                        
                        await f.write(chunk)
                        downloaded += len(chunk)
                        info["completedLength"] = downloaded
                        
                        # Update progress periodically
                        now = time.time()
                        if now - last_update >= 0.5:  # Update every 500ms
                            dt = now - last_update
                            speed = (downloaded - last_downloaded) / dt
                            info["downloadSpeed"] = int(speed)
                            
                            if total > 0:
                                info["percent"] = min(100.0, (downloaded / total) * 100.0)
                            info["eta"] = _eta(total, downloaded, speed)
                            
                            last_update = now
                            last_downloaded = downloaded
                            
                            # Yield control to prevent blocking
                            await asyncio.sleep(0.001)
        
        # Handle completion
        if info["status"] == "stopped":
            if os.path.exists(tmp_path):
                await asyncio.get_event_loop().run_in_executor(_executor, os.remove, tmp_path)
            return
        
        # Move file to final location
        def move_file():
            if os.path.exists(final_path):
                os.remove(final_path)
            os.rename(tmp_path, final_path)
        
        await asyncio.get_event_loop().run_in_executor(_executor, move_file)
        
        info["status"] = "complete"
        info["percent"] = 100.0
        
    except asyncio.CancelledError:
        info["status"] = "stopped"
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except:
                pass
    except Exception as e:
        info["status"] = "error"
        info["error"] = str(e)
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
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
    token = os.environ.get("hf_read_token") or os.environ.get("HF_TOKEN")

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
