import os
import re
import json
import time
import threading
from uuid import uuid4
from typing import Dict, Any
import weakref

import requests
from aiohttp import web
from server import PromptServer
from huggingface_hub import HfApi, hf_hub_url

# ========= simple progress store =========
_downloads: Dict[str, Dict[str, Any]] = {}
_stop_flags: Dict[str, bool] = {}
_active_threads: Dict[str, threading.Thread] = {}

_SANITIZE_RE = re.compile(r'[\\/:*?"<>|\x00-\x1F]')

def _sanitize_filename(name: str) -> str:
    return _SANITIZE_RE.sub("_", name).strip()

def _eta(total, done, speed):
    if speed and total and done is not None:
        rem = max(0, total - done)
        return int(rem / max(1, speed))
    return None

def _cleanup_download(gid: str):
    """Clean up download resources"""
    try:
        if gid in _downloads:
            del _downloads[gid]
        if gid in _stop_flags:
            del _stop_flags[gid]
        if gid in _active_threads:
            del _active_threads[gid]
    except Exception:
        pass

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
        session = None
        tmp_path = None
        try:
            t0 = time.time()
            last_t, last_done = t0, 0
            
            api = HfApi(token=token) if token else HfApi()
            
            # Query file size with timeout
            try:
                file_info = api.repo_file_info(repo_id=repo_id, path_in_repo=filename)
                total = int(file_info.size or 0)
            except Exception as e:
                print(f"Warning: Could not get file size for {repo_id}/{filename}: {e}")
                total = 0
                
            info["totalLength"] = total

            url = hf_hub_url(repo_id=repo_id, filename=filename)
            headers = {
                "User-Agent": "ComfyUI-HF-Downloader",
                "Accept": "*/*",
                "Connection": "keep-alive"
            }
            if token:
                headers["Authorization"] = f"Bearer {token}"

            tmp_path = info["filepath"] + ".part"
            
            # Use session for better connection management
            session = requests.Session()
            session.headers.update(headers)
            
            # Add connection timeout and read timeout
            with session.get(url, stream=True, timeout=(30, 60)) as response:
                response.raise_for_status()
                info["status"] = "active"
                
                # Use buffered writing
                with open(tmp_path, "wb") as f:
                    buffer = bytearray()
                    buffer_size = 1024 * 64  # 64KB buffer
                    
                    for chunk in response.iter_content(chunk_size=1024 * 32):  # 32KB chunks
                        # Check for stop flag more frequently
                        if _stop_flags.get(gid, False):
                            info["status"] = "stopped"
                            break
                            
                        if not chunk:
                            continue
                            
                        buffer.extend(chunk)
                        
                        # Write buffer when it's full
                        if len(buffer) >= buffer_size:
                            f.write(buffer)
                            f.flush()  # Ensure data is written
                            info["completedLength"] += len(buffer)
                            buffer.clear()
                            
                            # Update progress
                            now = time.time()
                            dt = max(0.1, now - last_t)  # Prevent division by zero
                            if dt >= 0.5:  # Update every 0.5 seconds
                                inc = info["completedLength"] - last_done
                                info["downloadSpeed"] = int(inc / dt)
                                last_t, last_done = now, info["completedLength"]
                                
                                tot = info.get("totalLength") or 0
                                if tot > 0:
                                    info["percent"] = min(100.0, round(info["completedLength"] / tot * 100.0, 2))
                                info["eta"] = _eta(tot, info["completedLength"], info["downloadSpeed"])
                    
                    # Write remaining buffer
                    if buffer and info["status"] != "stopped":
                        f.write(buffer)
                        f.flush()
                        info["completedLength"] += len(buffer)
                        
            # Handle completion
            if info["status"] == "stopped":
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
                return
                
            # Move to final destination
            if tmp_path and os.path.exists(tmp_path):
                try:
                    if os.path.exists(info["filepath"]):
                        os.remove(info["filepath"])  # Remove existing file first
                    os.rename(tmp_path, info["filepath"])
                    info["status"] = "complete"
                    info["percent"] = 100.0
                except Exception as e:
                    info["status"] = "error"
                    info["error"] = f"Failed to move file: {e}"
            else:
                info["status"] = "error"
                info["error"] = "Download incomplete - temporary file missing"
                
        except requests.exceptions.Timeout:
            info["status"] = "error"
            info["error"] = "Download timed out"
        except requests.exceptions.ConnectionError:
            info["status"] = "error"
            info["error"] = "Connection error"
        except requests.exceptions.HTTPError as e:
            info["status"] = "error"
            info["error"] = f"HTTP error: {e}"
        except Exception as e:
            info["status"] = "error"
            info["error"] = str(e)
        finally:
            # Cleanup resources
            if session:
                try:
                    session.close()
                except Exception:
                    pass
                    
            if tmp_path and os.path.exists(tmp_path) and info.get("status") in ["error", "stopped"]:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                    
            # Clean up thread reference
            if gid in _active_threads:
                del _active_threads[gid]

    # Create and start worker thread
    worker_thread = threading.Thread(target=_worker, daemon=True)
    _active_threads[gid] = worker_thread
    worker_thread.start()
    
    return web.json_response({
        "gid": gid, 
        "dest_dir": dest_dir, 
        "guessed_out": filename, 
        "confident": True
    })


@PromptServer.instance.routes.get("/hf/status")
async def hf_status(request):
    gid = request.query.get("gid")
    if not gid or gid not in _downloads:
        return web.json_response({"error": "unknown gid"}, status=400)
        
    info = _downloads[gid]
    out = {
        "status": info.get("status", "unknown"),
        "percent": float(info.get("percent", 0.0)),
        "completedLength": int(info.get("completedLength", 0)),
        "totalLength": int(info.get("totalLength", 0)),
        "downloadSpeed": int(info.get("downloadSpeed", 0)),
        "eta": info.get("eta"),
        "filename": info.get("filename", ""),
        "filepath": info.get("filepath", ""),
    }
    
    if info.get("status") == "error" and info.get("error"):
        out["error"] = info["error"]
    
    # Clean up completed/failed downloads after some time
    if info.get("status") in ["complete", "error", "stopped"]:
        # Schedule cleanup after a delay (allows UI to get final status)
        def delayed_cleanup():
            time.sleep(5)  # Wait 5 seconds
            _cleanup_download(gid)
        threading.Thread(target=delayed_cleanup, daemon=True).start()
    
    return web.json_response(out)


@PromptServer.instance.routes.post("/hf/stop")
async def hf_stop(request):
    body = await request.json()
    gid = (body.get("gid") or "").strip()
    
    if not gid or gid not in _downloads:
        return web.json_response({"error": "unknown gid"}, status=400)
    
    _stop_flags[gid] = True
    
    # Wait a bit for graceful stop
    if gid in _active_threads:
        thread = _active_threads[gid]
        if thread.is_alive():
            # Give thread time to stop gracefully
            thread.join(timeout=2.0)
    
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
