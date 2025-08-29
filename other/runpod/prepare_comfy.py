#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import subprocess
import threading
from pathlib import Path
from huggingface_hub import hf_hub_download
import shutil
import urllib.request
from typing import List, Tuple

# ----------------------------
# Environment & config helpers
# ----------------------------

def _req_env(name: str) -> Path:
    """Require an environment variable and return it as a Path with a clear error if missing."""
    val = os.getenv(name)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return Path(val)

def _env_flag(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "y", "on")

# Required paths
COMFY   = _req_env("COMFYUI_PATH")
MODELS  = _req_env("COMFYUI_MODEL_PATH")
workspace = COMFY.parent
CUSTOM  = COMFY / "custom_nodes"
USER    = COMFY / "user" / "default"

# Download list source
LIST_URL_DEFAULT = "https://raw.githubusercontent.com/azoksky/az-nodes/refs/heads/main/other/runpod/download_list.txt"
LIST_URL_ENV = (os.environ.get("DOWNLOAD_LIST") or "").strip() or LIST_URL_DEFAULT

# Feature flags
DOWNLOAD_MODELS = _env_flag("DOWNLOAD_MODELS", default=False)

# ----------
# Utilities
# ----------

def run(cmd: List[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command with basic logging."""
    pretty = " ".join(cmd)
    print(f"→ {pretty}")
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check)

def clone(repo: str, dest: Path, attempts: int = 2) -> None:
    """Shallow clone if missing, with a tiny retry for transient network hiccups."""
    if dest.exists():
        print(f"✓ already present: {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    for i in range(1, attempts + 1):
        try:
            run(["git", "clone", "--depth=1", "--single-branch", "--no-tags", repo, str(dest)])
            print(f"✓ cloned: {repo} → {dest}")
            return
        except subprocess.CalledProcessError as e:
            print(f"⚠ clone attempt {i}/{attempts} failed for {repo}: {e}")
            if i == attempts:
                raise

def install_missing_from_env(var: str = "MISSING_PACKAGES") -> None:
    """Optionally install transient Python packages listed in env: NAME1,NAME2,... (no-deps)."""
    raw = os.environ.get(var, "")
    if not raw.strip():
        return
    packages = [p.strip() for p in raw.split(",") if p.strip()]
    for pkg in packages:
        try:
            subprocess.check_call([
                sys.executable, "-m", "pip", "install",
                "--no-cache-dir", "--no-input", "-q", pkg
            ])
            print(f"✓ installed: {pkg}")
        except subprocess.CalledProcessError as e:
            print(f"✗ failed to install {pkg}: {e}")
        except Exception as e:
            print(f"✗ error installing {pkg}: {e}")

# ------------------------------
# Background installer (threaded)
# ------------------------------

def bg_install_impact() -> None:
    """
    Runs in ONE background thread.
    1) Fetches settings/config files.
    2) Sequentially runs Impact-Pack and Impact-Subpack installers (no extra threads).
    """
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
                # Add a UA to avoid occasional 403s from some CDNs
                req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
                with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
                    shutil.copyfileobj(r, f)
                tmp.replace(dest)  # atomic move
                print(f"✓ downloaded: {dest}  ← {url}")
                return True
            except Exception as e:
                print(f"⚠ attempt {i}/{attempts} failed for {url}: {e}")
                tmp.unlink(missing_ok=True)
        print(f"✗ giving up on {url}")
        return False

    all_ok = True
    for url, dest in downloads:
        if not _fetch(url, dest):
            all_ok = False

    if all_ok:
        print("✓ Successfully applied all settings.")
    else:
        print("⚠ Some settings failed to download (continuing).")

    # Sequential installers (no additional threads)
    targets = [
        CUSTOM / "ComfyUI-Impact-Pack" / "install.py",
        CUSTOM / "ComfyUI-Impact-Subpack" / "install.py",
    ]

    def _run(ipy: Path) -> None:
        if not ipy.is_file():
            print(f"… installer not found yet (will skip): {ipy}")
            return
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

    for ipy in targets:
        _run(ipy)

# ---------------
# Model downloads
# ---------------

def download_models_if_enabled() -> None:
    if not DOWNLOAD_MODELS:
        return
    try:
        file_list_path = workspace / "download_list.txt"
        tmp = file_list_path.with_suffix(file_list_path.suffix + ".part")

        # Fetch the list file
        req = urllib.request.Request(LIST_URL_ENV, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(file_list_path)
        print(f"✓ downloaded: {file_list_path}  ← {LIST_URL_ENV}")
        print("Downloading models now.....")

        stage_dir = workspace / "_hfstage"
        stage_dir.mkdir(parents=True, exist_ok=True)

        if not file_list_path.is_file():
            print(f"⚠ No download list found at {file_list_path}, skipping model downloads.")
            return

        with file_list_path.open("r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip() and not line.strip().startswith("#")]

        total = len(lines)
        print(f"Found {total} files to download.")

        for idx, line in enumerate(lines, 1):
            try:
                parts = [x.strip() for x in line.split(",", 2)]
                if len(parts) != 3:
                    print(f"⚠ Skipping malformed line {idx}: {line}")
                    continue

                repo_id, file_in_repo, local_subdir = parts
                if not repo_id or not file_in_repo or not local_subdir:
                    print(f"⚠ Skipping incomplete line {idx}: {line}")
                    continue

                target_dir = MODELS / local_subdir.strip("/\\")
                target_dir.mkdir(parents=True, exist_ok=True)

                print(f"[{idx}/{total}] Downloading '{file_in_repo}' from '{repo_id}' → '{target_dir}' ...")
                # unique subfolder per item to avoid temp collisions
                downloaded_path = hf_hub_download(
                    repo_id=repo_id,
                    filename=file_in_repo,
                    token=os.environ.get("HF_READ_TOKEN"),
                    local_dir=str(stage_dir / f"{idx:05d}")
                )

                src = Path(downloaded_path)
                dst = target_dir / src.name
                shutil.move(str(src), str(dst))
                print(f"✓ Finished: {dst}")

            except Exception as e:
                print(f"⚠ Error on line {idx}: {line} → {e}")
                continue
    except Exception as e:
        print(f"⚠ Failed to fetch or process download list: {e}")
    finally:
        stage_dir = workspace / "_hfstage"
        if stage_dir.exists():
            shutil.rmtree(stage_dir, ignore_errors=True)
            print(f"🧹 Cleaned up staging folder: {stage_dir}")

# -----
# Main
# -----

def main() -> None:
    install_missing_from_env()
    workspace.mkdir(parents=True, exist_ok=True)

    # 1) Clone core ComfyUI
    if not COMFY.exists():
        clone("https://github.com/comfyanonymous/ComfyUI.git", COMFY)
    CUSTOM.mkdir(parents=True, exist_ok=True)

    # 2) Clone Impact-Pack
    impact_pack = CUSTOM / "ComfyUI-Impact-Pack"
    clone("https://github.com/ltdrdata/ComfyUI-Impact-Pack.git", impact_pack)

    # 3) Clone Impact-Subpack
    impact_subpack = CUSTOM / "ComfyUI-Impact-Subpack"
    clone("https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git", impact_subpack)

    # 4) Clone rgthree-comfy
    rgthree_comfy = CUSTOM / "rgthree-comfy"
    clone("https://github.com/rgthree/rgthree-comfy.git", rgthree_comfy)

    # 5) Start ONE background thread for impact installers (sequential inside)
    t = threading.Thread(target=bg_install_impact, daemon=False)
    t.start()

    # 6) Clone the rest (no duplicates)
    for repo, name in [
        ("https://github.com/ltdrdata/ComfyUI-Manager.git",                 "ComfyUI-Manager"),
        ("https://github.com/Kosinkadink/ComfyUI-Advanced-ControlNet.git",  "ComfyUI-Advanced-ControlNet"),
        ("https://github.com/ssitu/ComfyUI_UltimateSDUpscale.git",          "ComfyUI_UltimateSDUpscale"),
        ("https://github.com/cubiq/ComfyUI_essentials.git",                 "ComfyUI_essentials"),
        ("https://github.com/kijai/ComfyUI-KJNodes.git",                    "ComfyUI-KJNodes"),
        ("https://github.com/city96/ComfyUI-GGUF.git",                      "ComfyUI-GGUF"),
        ("https://github.com/azoksky/RES4LYF.git",                          "RES4LYF"),
        ("https://github.com/azoksky/az-nodes.git",                         "az-nodes"),
        ("https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git",     "ComfyUI-VideoHelperSuite"),
        ("https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git",   "ComfyUI-Frame-Interpolation"),
        ("https://github.com/welltop-cn/ComfyUI-TeaCache.git",              "ComfyUI-TeaCache"),
        ("https://github.com/nunchaku-tech/ComfyUI-nunchaku.git",           "ComfyUI-nunchaku"),
    ]:
        clone(repo, CUSTOM / name)

    # 7) Optional model downloads
    download_models_if_enabled()

    # 8) Wait for background installers to finish before exit
    t.join()
    print("🚀 SUCCESSFUL.. NOW RUN COMFY")

if __name__ == "__main__":
    main()
