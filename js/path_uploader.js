import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function attachWidgets(node) {
  if (node.__pathUploaderAttached) return;
  node.__pathUploaderAttached = true;

  const destW   = node.widgets?.find(w => w.name === "dest_folder");
  const statusW = node.addWidget("text", "status", "idle", null, { serialize:false, disabled:true });
  const progW   = node.addWidget("number", "progress %", 0, null, { min:0, max:100, step:1, serialize:false, disabled:true });

  node.addWidget("button", "Pick & upload → <dest_folder>", null, () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) return;

      let dest = (destW?.value || "").trim();
      if (!dest) {
        app.extensionManager.toast.addAlert("Enter a destination folder path");
        return;
      }

      statusW.value = `Uploading ${file.name}…`;
      progW.value = 0;
      node.setDirtyCanvas(true);

      // Use our backend route; api.apiURL handles /api prefix differences
      const url = api.apiURL(`/pathuploader/upload-any?dest=${encodeURIComponent(dest)}`);

      const fd = new FormData();
      fd.append("file", file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          progW.value = Math.round((ev.loaded / ev.total) * 100);
          node.setDirtyCanvas(true);
        }
      };

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;

        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            const resp = JSON.parse(xhr.responseText || "{}");
            statusW.value = `Uploaded: ${resp.path || "(unknown path)"}`;
            progW.value = 100;
            app.extensionManager.toast.add({
              severity: "success",
              summary: "Upload complete",
              detail: resp.path || dest,
              life: 2500
            });
          } else {
            statusW.value = `Error ${xhr.status}`;
            app.extensionManager.toast.add({
              severity: "error",
              summary: "Upload failed",
              detail: xhr.responseText || `HTTP ${xhr.status}`
            });
          }
        } catch (e) {
          statusW.value = `Error: ${e}`;
          app.extensionManager.toast.add({
            severity: "error",
            summary: "Upload error",
            detail: String(e)
          });
        }
        node.setDirtyCanvas(true);
      };

      xhr.send(fd);
    };
    picker.click();
  }, { serialize:false });

  node.setSize(node.computeSize());
}

app.registerExtension({
  name: "vandana.pathuploader.any",
  init() { console.log("[PathUploader] frontend loaded (any-path)"); },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.comfyClass === "UploadToAnyPath") {
      const orig = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        orig?.apply(this, arguments);
        attachWidgets(this);
      };
      console.log("[PathUploader] hooked into", nodeData?.comfyClass);
    }
  },
  nodeCreated(node) {
    if (node?.comfyClass === "UploadToAnyPath") attachWidgets(node);
  }
});
