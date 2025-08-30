#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
prepare_comfy.py
----------------
Production-ready script to prepare ComfyUI environment.

Features:
1. Installs missing Python packages if specified in env.
2. Clones ComfyUI core repo (if missing).
3. Downloads node list from CUSTOM_NODE_URL_LIST.
   - For each repo: clone into custom_nodes/
   - If install.py exists, run in background thread.
4. Downloads settings list from SETTINGS_URL_LIST.
   - Each line: url,relative/path/in/comfyui
   - Downloads file into COMFY dir (with validation).
5. Optionally downloads models if DOWNLOAD_MODELS=1.
6. Waits for all background threads before exit.
"""

import os
import sys
import subprocess
import threading
from pathlib import Path
from typing import List
import shutil
import urllib.request
from huggingface_hub import hf_hub_download

# ----------------------------
# Environment & paths
# ----------------------------

def _req_env(name: str) -> Path:
    val = os.getenv(name)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return Path(val).expanduser().resolve()   # ensure absolute path

def _env_flag(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "y", "on")

COMFY   = _req_env("COMFYUI_PATH")
MODELS  = _req_env("COMFYUI_MODEL_PATH")
workspace = COMFY.parent
CUSTOM  = COMFY / "custom_nodes"
USER    = COMFY / "user" / "default"

# Node list URL (override via env)
CUSTOM_NODE_URL_LIST_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/custom_node_list.txt"
CUSTOM_NODE_URL_LIST = os.environ.get("CUSTOM_NODE_URL_LIST", CUSTOM_NODE_URL_LIST_DEFAULT).strip()

# Model download list URL
MODELS_URL_LIST_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/download_list.txt"
MODELS_URL_LIST = (os.environ.get("MODELS_URL_LIST") or "").strip() or MODELS_URL_LIST_DEFAULT

# Settings download list URL
SETTINGS_URL_LIST_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/settings_list.txt"
SETTINGS_URL_LIST = (os.environ.get("SETTINGS_URL_LIST") or "").strip() or SETTINGS_URL_LIST_DEFAULT

DOWNLOAD_MODELS = _env_flag("DOWNLOAD_MODELS", default=False)

# ----------
# Utilities
# ----------

def run(cmd: List[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    pretty = " ".join(cmd)
    print(f"→ {pretty}")
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check)

def install_missing_from_env(var: str = "MISSING_PACKAGES") -> None:
    """Install packages from env var: MISSING_PACKAGES=pack1,pack2,..."""
    raw = os.environ.get(var, "")
    if not raw.strip():
        return
    for pkg in [p.strip() for p in raw.split(",") if p.strip()]:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--no-cache-dir", "-q", pkg])
            print(f"✓ installed: {pkg}")
        except Exception as e:
            print(f"✗ error installing {pkg}: {e}")

# ---------------------------
# Installer runner
# ---------------------------

def run_installer(ipy: Path) -> None:
    """Run install.py in its directory (blocking)."""
    try:
        print(f"↗ running installer: {ipy}")
        proc = subprocess.Popen([sys.executable, "-B", str(ipy)], cwd=ipy.parent)
        proc.wait()
        if proc.returncode == 0:
            print(f"✓ installer finished: {ipy}")
        else:
            print(f"⚠ installer failed ({proc.returncode}): {ipy}")
    except Exception as e:
        print(f"⚠ installer error for {ipy}: {e}")

# ---------------------------
# Clone with install support
# ---------------------------

def clone(repo: str, dest: Path, threads: list[threading.Thread], name: str | None = None, attempts: int = 2) -> None:
    """Clone repo, and if install.py exists, run only for impact-related repos."""
    if dest.exists():
        if (dest / ".git").exists():
            print(f"✓ already present: {dest}")
            return
        else:
            print(f"⚠ {dest} exists but is not a valid git repo. Removing...")
            shutil.rmtree(dest, ignore_errors=True)

    dest.parent.mkdir(parents=True, exist_ok=True)

    for i in range(1, attempts + 1):
        try:
            run(["git", "clone", "--depth=1", "--single-branch", "--no-tags", repo, str(dest)])
            print(f"✓ cloned: {repo} → {dest}")

            ipy = dest / "install.py"
            if ipy.is_file():
                if name and "impact" in name.lower():  # case-insensitive check
                    t = threading.Thread(target=run_installer, args=(ipy,), daemon=False)
                    t.start()
                    threads.append(t)
                    print(f"↗ installer scheduled for impact node: {name}")
                else:
                    print(f"⏩ skipping installer for non-impact node: {name or dest.name}")

            return
        except subprocess.CalledProcessError as e:
            print(f"⚠ clone attempt {i}/{attempts} failed for {repo}: {e}")
            if i == attempts:
                raise


# ---------------------------
# Fetch node list
# ---------------------------

def fetch_node_list() -> list[str]:
    """Download the custom_node_list.txt and return repos."""
    try:
        req = urllib.request.Request(CUSTOM_NODE_URL_LIST, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r:
            content = r.read().decode("utf-8")
        lines = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]
        if not lines:
            print(f"⚠ Node list from {CUSTOM_NODE_URL_LIST} is empty, skipping custom nodes.")
        else:
            print(f"✓ fetched {len(lines)} repos from {CUSTOM_NODE_URL_LIST}")
        return lines
    except Exception as e:
        print(f"⚠ Failed to fetch node list from {CUSTOM_NODE_URL_LIST}: {e}")
        return []

# ---------------------------
# Settings/config fetch
# ---------------------------

def apply_settings() -> None:
    """Fetch and apply settings/config files defined in SETTINGS_URL_LIST."""
    try:
        req = urllib.request.Request(SETTINGS_URL_LIST, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r:
            content = r.read().decode("utf-8")

        lines = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]
        if not lines:
            print(f"⚠ Settings list from {SETTINGS_URL_LIST} is empty, skipping settings.")
            return
        else:
            print(f"✓ fetched {len(lines)} settings entries from {SETTINGS_URL_LIST}")
    except Exception as e:
        print(f"⚠ Failed to fetch settings list from {SETTINGS_URL_LIST}: {e}")
        return

    all_ok = True
    for idx, line in enumerate(lines, 1):
        try:
            parts = [x.strip() for x in line.split(",", 1)]
            if len(parts) != 2:
                print(f"⚠ Skipping malformed line {idx}: {line}")
                continue

            url, rel_path = parts
            dest = (COMFY / rel_path).resolve()

            # Security check: must stay inside COMFY
            if not str(dest).startswith(str(COMFY.resolve())):
                print(f"✗ Invalid path outside COMFY detected, skipping: {dest}")
                all_ok = False
                continue

            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")

            success = False
            for attempt in range(1, 4):  # up to 3 retries
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
                    with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
                        shutil.copyfileobj(r, f)
                    tmp.replace(dest)  # atomic rename
                    print(f"✓ downloaded: {dest} ← {url}")
                    success = True
                    break
                except Exception as e:
                    print(f"⚠ attempt {attempt}/3 failed for {url}: {e}")
                    tmp.unlink(missing_ok=True)

            if not success:
                print(f"✗ giving up on {url}")
                all_ok = False

        except Exception as e:
            print(f"⚠ Error processing line {idx}: {line} → {e}")
            all_ok = False
    if all_ok:
        print("✓ Successfully applied all settings.")
    else:
        print("⚠ Some settings failed to download (continuing).")
    print("🚀 SUCCESSFUL.. NOW RUN COMFY--------------------------------------------------------------")  


# ---------------------------
# Model downloads
# ---------------------------

def download_models_if_enabled() -> None:
    if not DOWNLOAD_MODELS:
        return
    try:
        file_list_path = workspace / "download_list.txt"
        tmp = file_list_path.with_suffix(file_list_path.suffix + ".part")

        req = urllib.request.Request(MODELS_URL_LIST, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(file_list_path)
        print(f"✓ downloaded: {file_list_path}  ← {MODELS_URL_LIST}")
        print("Downloading models now.....")

        stage_dir = workspace / "_hfstage"
        stage_dir.mkdir(parents=True, exist_ok=True)

        with file_list_path.open("r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]

        if not lines:
            print(f"⚠ Model list from {MODELS_URL_LIST} is empty, skipping model downloads.")
            return

        total = len(lines)
        print(f"Found {total} files to download.")

        for idx, line in enumerate(lines, 1):
            try:
                repo_id, file_in_repo, local_subdir = [x.strip() for x in line.split(",", 2)]
                target_dir = MODELS / local_subdir.strip("/\\")
                target_dir.mkdir(parents=True, exist_ok=True)

                dst = target_dir / Path(file_in_repo).name
                if dst.exists():
                    print(f"⏩ skipping already present: {dst}")
                    continue

                print(f"[{idx}/{total}] {file_in_repo} ← {repo_id}")
                downloaded_path = hf_hub_download(
                    repo_id=repo_id,
                    filename=file_in_repo,
                    token=os.environ.get("HF_READ_TOKEN"),
                    local_dir=str(stage_dir / f"{idx:05d}")
                )

                src = Path(downloaded_path)
                shutil.move(str(src), str(dst))
                print(f"✓ Finished: {dst}")
            except Exception as e:
                print(f"⚠ Error on line {idx}: {line} → {e}")
    except Exception as e:
        print(f"⚠ Failed to fetch model list: {e}")
    finally:
        shutil.rmtree(workspace / "_hfstage", ignore_errors=True)

# ---------------------------
# Main
# ---------------------------

def main() -> None:
    install_missing_from_env()
    workspace.mkdir(parents=True, exist_ok=True)
    CUSTOM.mkdir(parents=True, exist_ok=True)

    threads: list[threading.Thread] = []

    # 1) Clone ComfyUI core
    if not COMFY.exists():
        clone("https://github.com/comfyanonymous/ComfyUI.git", COMFY, threads)

    # 2) Fetch & clone nodes
    repos = fetch_node_list()
    for repo in repos:
        name = repo.rstrip("/").split("/")[-1].replace(".git", "")
        dest = CUSTOM / name
        clone(repo, dest, threads, name)

    # 3) Apply settings
    t = threading.Thread(target=apply_settings, daemon=False)
    t.start()
    threads.append(t)

    # 4) Optional model downloads
    download_models_if_enabled()

    # 5) Wait for all background tasks
    for t in threads:
        t.join()
   
if __name__ == "__main__":
    main()
