import os
from pathlib import Path
from aiohttp import web
from server import PromptServer

def _normalize_dest_folder(text: str) -> Path:
    """
    Accept absolute or relative folder paths:
    - Expands ~ and %VARS%
    - Converts backslashes/slashes as needed
    - Relative paths are resolved against *current working dir*
    """
    if not text:
        raise ValueError("Empty destination")

    # Expand env vars and ~
    text = os.path.expandvars(text.strip())
    text = os.path.expanduser(text)

    # Normalize separators (Path handles slashes on Windows)
    # Allow both "C:\\x\\y" and "C:/x/y"
    p = Path(text)

    # If it's relative, anchor to the process CWD (where you launched ComfyUI)
    if not p.is_absolute():
        p = (Path(os.getcwd()) / p).resolve()

    return p

def _register(routes, route_path: str):
    print(f"[PathUploader] Register {route_path} (write ANYWHERE—be careful)")

    @routes.options(route_path)
    async def preflight(request):
        return web.Response(status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        })

    @routes.post(route_path)
    async def upload_any(request):
        # The client sends ?dest=<folder path> (URL-encoded)
        dest = request.query.get("dest", "")
        if not dest:
            return web.json_response({"error": "missing ?dest"}, status=400)

        try:
            dest_dir = _normalize_dest_folder(dest)
        except Exception as e:
            return web.json_response({"error": f"invalid dest: {e}"}, status=400)

        # Create the destination folder tree
        dest_dir.mkdir(parents=True, exist_ok=True)

        # Pick up filename from multipart (preferred) or query/body
        filename = request.query.get("filename", "upload.bin")
        if request.content_type and request.content_type.startswith("multipart/"):
            post = await request.post()
            filefield = post.get("file")
            if filefield is None:
                return web.json_response({"error": "no file part"}, status=400)
            filename = filefield.filename or filename
            data = filefield.file.read()
        else:
            data = await request.read()

        final_path = (dest_dir / filename)
        try:
            with open(final_path, "wb") as f:
                f.write(data)
        except Exception as e:
            return web.json_response({"error": f"I/O error: {e}"}, status=500)

        return web.json_response(
            {"ok": True, "path": str(final_path)},
            headers={"Access-Control-Allow-Origin": "*"},
        )

def add_routes():
    routes = PromptServer.instance.routes
    # Register with and without /api to match different server mounts
    _register(routes, "/pathuploader/upload-any")
    _register(routes, "/api/pathuploader/upload-any")

class UploadToAnyPath:
    """
    Node: user types a *folder path*. Upload starts immediately from the frontend.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "dest_folder": ("STRING", {
                "default": "input/azok",  # relative → goes under your launch directory
                "multiline": False
            }),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("dest_folder",)
    FUNCTION = "echo"
    CATEGORY = "AZ_Nodes"

    def echo(self, dest_folder: str):
        return (dest_folder.strip(),)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")
