
#from .generate_clip_prompt_node import GenerateCLIPPromptNode
from .extra_node import AzInput, OverrideCLIPDevice, FluxResolutionNode, GetImageSizeRatio, OverrideVAEDevice, OverrideMODELDevice,PurgeVRAM, PurgeVRAM_V2, AnyType
from .path_uploader import UploadToAnyPath, add_routes
from .Downloader_helper import Aria2Downloader



NODE_CLASS_MAPPINGS = {
    #"GenerateCLIPPromptNode": GenerateCLIPPromptNode,
    "Aria2Downloader": Aria2Downloader,
    "AzInput": AzInput,
    "OverrideCLIPDevice": OverrideCLIPDevice,
    "OverrideVAEDevice": OverrideVAEDevice,
    "OverrideMODELDevice": OverrideMODELDevice,
    "FluxResolutionNode": FluxResolutionNode,
    "GetImageSizeRatio": GetImageSizeRatio,
    "PurgeVRAM_V1": PurgeVRAM,
    "PurgeVRAM_V2": PurgeVRAM_V2,
    "UploadToAnyPath": UploadToAnyPath
}

NODE_DISPLAY_NAME_MAPPINGS = {
    # "GenerateCLIPPromptNode": "Generate CLIP Prompt",
    "Aria2Downloader": "Aria2 Downloader",
    "AzInput": "Input String",
    "OverrideCLIPDevice": "Force/Set CLIP Device",
    "OverrideVAEDevice": "Force/Set VAE Device",
    "OverrideMODELDevice": "Force/Set MODEL Device",
    "FluxResolutionNode": "Flux Resolution Calc",
    "GetImageSizeRatio": "Get Image Size Ratio",
    "PurgeVRAM": "Purge VRAM V1",
    "PurgeVRAM_V2": "Purge VRAM V2",
    "UploadToAnyPath": "Upload → Any Folder Path"
    
}

WEB_DIRECTORY = "./js"
add_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

