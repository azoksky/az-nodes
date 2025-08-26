import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}

function fmtETA(s) {
  if (!s || s <= 0) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  const { style, ...rest } = attrs || {};
  if (rest) Object.assign(n, rest);
  if (style && typeof style === "object") Object.assign(n.style, style);
  for (const c of children) n.append(c);
  return n;
}

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    const wrap = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", padding: "10px" } });

    // Simple inputs
    const repoInput = el("input", {
      type: "text",
      placeholder: "Repository ID (e.g. runwayml/stable-diffusion-v1-5)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const fileInput = el("input", {
      type: "text",
      placeholder: "Filename (e.g. v1-5-pruned-emaonly.ckpt)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const destInput = el("input", {
      type: "text",
      placeholder: "Destination folder (e.g. ./models)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    // Progress display
    const progressBar = el("div", { style: { height: "10px", background: "#333", borderRadius: "5px", overflow: "hidden", width: "100%" } });
    const progressFill = el("div", { style: { height: "100%", width: "0%", background: "#0084ff", transition: "width 0.3s ease" } });
    progressBar.append(progressFill);

    const statusText = el("div", {
      style: { fontSize: "12px", color: "#ccc", minHeight: "16px", textAlign: "center" },
      textContent: "Ready"
    });

    // Buttons
    const buttonRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "center" } });
    const downloadBtn = el("button", { textContent: "Download", style: { padding: "6px 12px", cursor: "pointer" } });
    const stopBtn = el("button", { textContent: "Stop", disabled: true, style: { padding: "6px 12px", cursor: "pointer" } });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(repoInput, fileInput, destInput, progressBar, statusText, buttonRow);

    // Add DOM widget
    node.addDOMWidget("hf_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => wrap.offsetHeight || 200
    });

    // Increase node width by 50 pixels
    const defaultWidth = node.size[0] || 300; // Default to 300 if size not set
    node.size[0] = defaultWidth + 50;

    // State management
    node.gid = null;
    node._pollInterval = null;
    node._pollCount = 0;

    function resetUI() {
      downloadBtn.disabled = false;
      stopBtn.disabled = true;
      progressFill.style.width = "0%";
      statusText.textContent = "Ready";
      node.gid = null;
      if (node._pollInterval) {
        clearInterval(node._pollInterval);
        node._pollInterval = null;
      }
      node._pollCount = 0;
    }

    function startPolling() {
      if (node._pollInterval) clearInterval(node._pollInterval);
      node._pollCount = 0;

      node._pollInterval = setInterval(async () => {
        if (!node.gid || node._pollCount > 200) { // Max 200 polls (~3 minutes)
          resetUI();
          return;
        }

        node._pollCount++;

        try {
          const response = await fetch(`/hf/status?gid=${encodeURIComponent(node.gid)}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" }
          });

          if (!response.ok) {
            throw new Error(`Status request failed: ${response.status}`);
          }

          const status = await response.json();

          if (status.error) {
            statusText.textContent = `Error: ${status.error}`;
            progressFill.style.width = "0%";
            resetUI();
            return;
          }

          // Update progress bar
          const percent = Math.min(100, Math.max(0, parseFloat(status.percent) || 0));
          progressFill.style.width = `${percent}%`;

          // Update status text
          const speed = status.downloadSpeed ? `${fmtBytes(status.downloadSpeed)}/s` : "";
          const eta = status.eta ? `ETA: ${fmtETA(status.eta)}` : "";
          const size = `${fmtBytes(status.completedLength || 0)}`;
          const total = status.totalLength ? `/${fmtBytes(status.totalLength)}` : "";
          statusText.textContent = `${percent.toFixed(1)}% - ${size}${total} ${speed} ${eta}`.trim();

          // Check completion
          if (status.status === "complete") {
            statusText.textContent = `✅ Download complete: ${status.filename}`;
            progressFill.style.width = "100%";
            resetUI();
          } else if (status.status === "error" || status.status === "stopped") {
            statusText.textContent = status.status === "stopped" ? "Download stopped" : `Download failed: ${status.error || "Unknown error"}`;
            progressFill.style.width = "0%";
            resetUI();
          }
        } catch (error) {
          console.warn("Status poll failed:", error);
          if (node._pollCount > 10) {
            statusText.textContent = `Error: Status check failed - ${error.message}`;
            progressFill.style.width = "0%";
            resetUI();
          }
        }
      }, 1000); // Poll every 1 second
    }

    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();

      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill all fields";
        progressFill.style.width = "0%";
        return;
      }

      downloadBtn.disabled = true;
      stopBtn.disabled = false;
      statusText.textContent = "Starting download...";
      progressFill.style.width = "0%";

      try {
        const response = await fetch("/hf/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_id, filename, dest_dir })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Start request failed: ${response.status} - ${errorText}`);
        }

        const result = await response.json();

        if (result.error) {
          statusText.textContent = `Error: ${result.error}`;
          progressFill.style.width = "0%";
          downloadBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }

        node.gid = result.gid;
        statusText.textContent = "Download started...";
        startPolling();
      } catch (error) {
        statusText.textContent = `Failed to start: ${error.message}`;
        progressFill.style.width = "0%";
        downloadBtn.disabled = false;
        stopBtn.disabled = true;
      }
    };

    stopBtn.onclick = async () => {
      if (!node.gid) return;

      try {
        await fetch("/hf/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gid: node.gid })
        });
        statusText.textContent = "Stopping...";
        progressFill.style.width = "0%";
      } catch (error) {
        console.warn("Stop request failed:", error);
        statusText.textContent = `Error stopping: ${error.message}`;
      }
      resetUI();
    };

    // Cleanup on node removal
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      resetUI();
      if (wrap && wrap.parentNode) wrap.remove();
      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
