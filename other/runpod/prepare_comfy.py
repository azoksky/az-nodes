#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
prepare_comfy.py
----------------
Deployment-ready script to prepare ComfyUI environment.

What it does:
1. Installs missing Python packages if specified in env.
2. Clones ComfyUI core repo (if missing).
3. Downloads `custom_node_list.txt` from GitHub each run.
   - For each repo in the list:
       - Clone into custom_nodes/
       - If an install.py exists, execute it in a background thread.
4. Applies default settings/configs (runs in its own thread).
5. Optionally downloads models (if DOWNLOAD_MODELS=1).
6. Waits for all threads before exiting.
"""

import os
import sys
import subprocess
import threading
from pathlib import Path
from typing import List, Tuple
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
    return Path(val)

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

NODE_LIST_URL = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/custom_node_list.txt"

LIST_URL_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/download_list.txt"
LIST_URL_ENV = (os.environ.get("DOWNLOAD_LIST") or "").strip() or LIST_URL_DEFAULT

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

def clone(repo: str, dest: Path, threads: list[threading.Thread], attempts: int = 2) -> None:
    """Clone repo, and if install.py exists, run it in background thread."""
    if dest.exists():
        print(f"✓ already present: {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)

    for i in range(1, attempts + 1):
        try:
            run(["git", "clone", "--depth=1", "--single-branch", "--no-tags", repo, str(dest)])
            print(f"✓ cloned: {repo} → {dest}")

            # Immediately check for install.py
            ipy = dest / "install.py"
            if ipy.is_file():
                t = threading.Thread(target=run_installer, args=(ipy,), daemon=False)
                t.start()
                threads.append(t)

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
        req = urllib.request.Request(NODE_LIST_URL, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r:
            content = r.read().decode("utf-8")
        lines = [line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")]
        print(f"✓ fetched {len(lines)} repos from {NODE_LIST_URL}")
        return lines
    except Exception as e:
        print(f"⚠ Failed to fetch node list: {e}")
        return []

# ---------------------------
# Settings/config fetch
# ---------------------------

def apply_settings() -> None:
    downloads: List[Tuple[str, Path]] = [
        (
            "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/comfy.settings.json",
            USER / "comfy.settings.json",
        ),
        (
            "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/rgthree_config.json",
            CUSTOM / "rgthree-comfy" / "rgthree_config.json",
        ),
    ]

    def _fetch(url: str, dest: Path, attempts: int = 3, timeout: int = 30) -> bool:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        for i in range(1, attempts + 1):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
                with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
                    shutil.copyfileobj(r, f)
                tmp.replace(dest)
                print(f"✓ downloaded: {dest}  ← {url}")
                return True
            except Exception as e:
                print(f"⚠ attempt {i}/{attempts} failed for {url}: {e}")
                tmp.unlink(missing_ok=True)
        return False

    all_ok = all(_fetch(url, dest) for url, dest in downloads)
    if all_ok:
        print("✓ Successfully applied all settings.")
    else:
        print("⚠ Some settings failed to download (continuing).")

# ---------------------------
# Model downloads
# ---------------------------

def download_models_if_enabled() -> None:
    if not DOWNLOAD_MODELS:
        return
    try:
        file_list_path = workspace / "download_list.txt"
        tmp = file_list_path.with_suffix(file_list_path.suffix + ".part")

        req = urllib.request.Request(LIST_URL_ENV, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(file_list_path)
        print(f"✓ downloaded: {file_list_path}  ← {LIST_URL_ENV}")
        print("Downloading models now.....")

        stage_dir = workspace / "_hfstage"
        stage_dir.mkdir(parents=True, exist_ok=True)

        with file_list_path.open("r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]

        total = len(lines)
        print(f"Found {total} files to download.")

        for idx, line in enumerate(lines, 1):
            try:
                repo_id, file_in_repo, local_subdir = [x.strip() for x in line.split(",", 2)]
                target_dir = MODELS / local_subdir.strip("/\\")
                target_dir.mkdir(parents=True, exist_ok=True)

                print(f"[{idx}/{total}] {file_in_repo} ← {repo_id}")
                downloaded_path = hf_hub_download(
                    repo_id=repo_id,
                    filename=file_in_repo,
                    token=os.environ.get("HF_READ_TOKEN"),
                    local_dir=str(stage_dir / f"{idx:05d}")
                )

                src = Path(downloaded_path)
                shutil.move(str(src), str(target_dir / src.name))
                print(f"✓ Finished: {target_dir / src.name}")
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
        clone(repo, dest, threads)

    # 3) Apply settings
    t = threading.Thread(target=apply_settings, daemon=False)
    t.start()
    threads.append(t)

    # 4) Optional model downloads
    download_models_if_enabled()

    # 5) Wait for all background tasks
    for t in threads:
        t.join()

    print("🚀 SUCCESSFUL.. NOW RUN COMFY")

if __name__ == "__main__":
    main()
