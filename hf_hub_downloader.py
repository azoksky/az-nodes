import os
import re
import json
import time
import asyncio
import logging
from uuid import uuid4
from typing import Dict, Any
from concurrent.futures import ThreadPoolExecutor
import threading
import glob

from aiohttp import web
from server import PromptServer
from huggingface_hub import HfApi

# Setup logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

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

def parse_bytes(s: str) -> int:
    units = {'B': 1, 'kB': 1024, 'MB': 1024**2, 'GB': 1024**3, 'TB': 1024**4}
    match = re.match(r"(\d+[.\d]*)([kMG]B)?", s.strip())
    if match:
        num = float(match.group(1))
        unit = match.group(2) or 'B'
        return int(num * units.get(unit, 1))
    return 0

def parse_eta(eta_str: str) -> int:
    if not eta_str:
        return None
    parts = eta_str.split(':')
    secs = 0
    for i, p in enumerate(reversed(parts)):
        secs += int(p) * (60 ** i)
    return secs

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
    """Async download using huggingface_cli with progress parsing"""
    info = _downloads[gid]
    final_path = os.path.join(dest_dir, _sanitize_filename(filename))
    info["filepath"] = final_path
    logger.debug(f"Starting download: repo_id={repo_id}, filename={filename}, dest_dir={dest_dir}")

    try:
        # Get file info for total size and verify existence (optional, but helps if CLI doesn't provide)
        def get_file_info():
            api = HfApi(token=token) if token else HfApi()
            try:
                try:
                    paths_info = api.get_paths_info(repo_id=repo_id, repo_type="model", paths=[filename])
                    if not paths_info or filename not in [p.path for p in paths_info]:
                        raise ValueError(f"File {filename} not found in repo {repo_id}")
                    file_info = next(p for p in paths_info if p.path == filename)
                    size = int(file_info.size or 0)
                    logger.debug(f"File info retrieved: size={size} bytes")
                    return size
                except AttributeError:
                    files = api.list_repo_files(repo_id=repo_id, repo_type="model")
                    if filename not in files:
                        raise ValueError(f"File {filename} not found in repo {repo_id}")
                    logger.debug("File exists, but size unavailable")
                    return 0
            except Exception as e:
                logger.error(f"Failed to get file info: {str(e)}")
                raise

        total = await asyncio.get_event_loop().run_in_executor(_executor, get_file_info)
        info["totalLength"] = total
        info["status"] = "active"

        # Build command
        cmd = ['huggingface-cli', 'download', repo_id, filename, '--local-dir', dest_dir]
        if token:
            cmd += ['--token', token]

        # Start subprocess
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        last_update = time.time()
        last_downloaded = 0

        while True:
            # Read from stdout and stderr
            tasks = [
                asyncio.create_task(proc.stdout.readline()),
                asyncio.create_task(proc.stderr.readline())
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                line = task.result()
                if line:
                    line = line.decode('utf-8').strip()
                    if line:
                        logger.debug(f"CLI output: {line}")
                        # Parse progress line
                        match = re.search(r"(\d+)% ([\d.]+[kMG]?B?)/([\d.]+[kMG]?B?)\s*\[.*? < (.*?), ([\d.]+[kMG]?B?/s)\]", line)
                        if match:
                            percent = int(match.group(1))
                            completed = parse_bytes(match.group(2))
                            total_from_cli = parse_bytes(match.group(3))
                            eta_str = match.group(4)
                            speed_str = match.group(5)

                            info["percent"] = percent
                            info["completedLength"] = completed
                            info["totalLength"] = total_from_cli if info["totalLength"] == 0 else info["totalLength"]
                            info["downloadSpeed"] = parse_bytes(speed_str.rstrip('/s'))
                            info["eta"] = parse_eta(eta_str)

                            logger.debug(f"Parsed progress: percent={percent}, completed={completed}, total={info['totalLength']}, speed={info['downloadSpeed']}, eta={info['eta']}")

            # Check if process done
            if proc.returncode is not None:
                break

            # Check stop flag
            if _stop_flags.get(gid, False):
                proc.terminate()
                await proc.wait()
                info["status"] = "stopped"
                break

            await asyncio.sleep(0.1)  # Small sleep to avoid busy loop

        await proc.wait()

        if proc.returncode == 0 and info["status"] != "stopped":
            info["status"] = "complete"
            info["percent"] = 100.0
            logger.debug("Download complete")
        else:
            info["status"] = "error"
            info["error"] = "Download failed or stopped"
            logger.debug("Download failed or stopped")

    except Exception as e:
        info["status"] = "error"
        info["error"] = str(e)
        logger.error(f"Download error: {str(e)}")
    finally:
        # Cleanup partial files (final_path.tmp.* or .part)
        if info["status"] != "complete":
            if os.path.exists(final_path):
                try:
                    os.remove(final_path)
                except:
                    pass
            for tmp_file in glob.glob(final_path + ".tmp.*") + glob.glob(final_path + ".part"):
                try:
                    os.remove(tmp_file)
                    logger.debug(f"Cleaned up partial file: {tmp_file}")
                except:
                    pass
        _schedule_cleanup(gid)

# Store active download tasks
_active_tasks: Dict[str, asyncio.Task] = {}

# ========= Routes =========
@PromptServer.instance.routes.post("/hf/start")
async def hf_start(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        logger.error("Invalid JSON in /hf/start request")
        return web.json_response({"error": "Invalid JSON in request body"}, status=400)
        
    repo_id = (body.get("repo_id") or "").strip()
    filename = (body.get("filename") or "").strip()
    dest_dir = (body.get("dest_dir") or "").strip()
    
    if not repo_id or not filename or not dest_dir:
        error_msg = "repo_id, filename, and dest_dir are required"
        logger.error(f"/hf/start failed: {error_msg}")
        return web.json_response({"error": error_msg}, status=400)
    
    # Validate destination directory
    try:
        if os.path.exists(dest_dir) and not os.path.isdir(dest_dir):
            error_msg = f"Destination path {dest_dir} is not a directory"
            logger.error(error_msg)
            return web.json_response({"error": error_msg}, status=400)
        os.makedirs(dest_dir, exist_ok=True)
        test_file = os.path.join(dest_dir, f".test_write_{uuid4().hex}")
        with open(test_file, "w") as f:
            f.write("test")
        os.remove(test_file)
    except Exception as e:
        error_msg = f"Cannot access or write to destination directory {dest_dir}: {str(e)}"
        logger.error(error_msg)
        return web.json_response({"error": error_msg}, status=400)

    gid = uuid4().hex
    token = os.environ.get("HF_READ_TOKEN") or os.environ.get("HF_TOKEN")
    logger.debug(f"Starting download task: gid={gid}, repo_id={repo_id}, filename={filename}, dest_dir={dest_dir}")

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
        logger.debug(f"Cleaned up task: gid={gid}")
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
        logger.error("Missing gid in /hf/status request")
        return web.json_response({"error": "gid parameter required"}, status=400)
    
    with _cleanup_lock:
        if gid not in _downloads:
            logger.error(f"Unknown gid in /hf/status: {gid}")
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
    
    logger.debug(f"Status response for gid={gid}: {out}")
    return web.json_response(out)

@PromptServer.instance.routes.post("/hf/stop")
async def hf_stop(request):
    try:
        body = await request.json()
        gid = (body.get("gid") or "").strip()
    except json.JSONDecodeError:
        logger.error("Invalid JSON in /hf/stop request")
        return web.json_response({"error": "Invalid JSON in request body"}, status=400)
    
    if not gid:
        logger.error("Missing gid in /hf/stop request")
        return web.json_response({"error": "gid is required"}, status=400)
    
    # Set stop flag
    _stop_flags[gid] = True
    logger.debug(f"Stop requested for gid={gid}")
    
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
