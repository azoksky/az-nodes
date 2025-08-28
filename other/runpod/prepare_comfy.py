#!/usr/bin/env python3
import os
import subprocess
import threading
from pathlib import Path
from huggingface_hub import snapshot_download, hf_hub_download
import shutil
import urllib.request

COMFY   = Path(os.environ["COMFYUI_PATH"])
MODELS  = Path(os.environ["COMFYUI_MODEL_PATH"])
workspace = COMFY.parent
CUSTOM  = COMFY / "custom_nodes"
USER    = COMFY / "user" / "default"

def run(cmd, cwd=None, check=True):
    print(f"→ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd, check=check)

def move_children(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        shutil.move(str(item), str(target))

def clone(repo: str, dest: Path):
    if dest.exists():
        print(f"✓ already present: {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "clone", "--depth=1", "--single-branch", "--no-tags", repo, str(dest)])

def bg_install_impact():
    downloads = [
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
                with urllib.request.urlopen(url, timeout=timeout) as r, open(tmp, "wb") as f:
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
    print(f"Successfully copied all settings..hurray")
    targets = [
        CUSTOM / "ComfyUI-Impact-Pack" / "install.py",
        CUSTOM / "ComfyUI-Impact-Subpack" / "install.py",
    ]
    def _run(ipy: Path):
        if ipy.is_file():
            try:
                print(f"↗ background install: {ipy}")
                proc = subprocess.Popen(["python", "-B", str(ipy)], cwd=ipy.parent)
                proc.wait()
                if proc.returncode == 0:
                    print(f"✓ installer finished: {ipy}")
                else:
                    print(f"⚠ installer failed ({proc.returncode}): {ipy}")
            except Exception as e:
                print(f"⚠ installer error for {ipy}: {e}")
        else:
            print(f"… installer not found yet (will skip): {ipy}")

    # Run both in their own tiny threads so they can overlap
    for ipy in targets:
        threading.Thread(target=_run, args=(ipy,), daemon=True).start()

def main():
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
    
    # 4) Clone rgthree-comfy (fixed missing quote)
    rgthree_comfy = CUSTOM / "rgthree-comfy"
    clone("https://github.com/rgthree/rgthree-comfy.git", rgthree_comfy)

    # 5) NOW start the background installers (your desired ordering)
    threading.Thread(target=bg_install_impact, daemon=True).start()

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

    print(f"Downloading models now.....")

    # Read list of (repo_id, file_in_repo, local_subdir) and download each via hf_hub_download
    file_list = "download_list.txt"
    stage_dir = workspace / "_hfstage"
    stage_dir.mkdir(parents=True, exist_ok=True)

    if os.path.isfile(file_list):
        with open(file_list, "r", encoding="utf-8") as f:
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

                downloaded_path = hf_hub_download(
                    repo_id=repo_id,
                    filename=file_in_repo,
                    token=os.environ.get("HF_READ_TOKEN"),
                    local_dir=str(stage_dir),  # stage to isolate hub's nested dirs
                )

                # Move the actual file (basename only) into the target_dir
                src = Path(downloaded_path)
                dst = target_dir / src.name

                shutil.move(str(src), str(dst))
                print(f"✓ Finished: {dst}")

            except Exception as e:
                print(f"⚠ Error on line {idx}: {line} → {e}")
                continue
    else:
        print(f"⚠ No download list found at {file_list}, skipping model downloads.")

    # Final cleanup: remove the entire staging folder
    try:
        if stage_dir.exists():
            shutil.rmtree(stage_dir, ignore_errors=True)
            print(f"🧹 Cleaned up staging folder: {stage_dir}")
    except Exception as e:
        print(f"⚠ Failed to remove staging folder {stage_dir}: {e}")

        
    print(f"🚀 SUCCCESSFUL.. NOW RUN COMFY")
if __name__ == "__main__":
    main()


 # # ensure the WAN snapshot goes under /workspace/wan (so the next line works)
    # snapshot_download(token=os.environ["HF_READ_TOKEN"],
    #     repo_id="azoksky/retention",
    #     allow_patterns=["*wan*"],
    #     local_dir=str(workspace))
    
    # move_children(workspace / "wan", MODELS)

    # subprocess.Popen([
    #     "python", "-B", "./ComfyUI/main.py",
    #     "--listen",
    #     "--preview-method", "latent2rgb",
    #     "--use-sage-attention",
    #     "--fast"
    # ], cwd="/workspace")





