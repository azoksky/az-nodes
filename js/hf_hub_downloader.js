import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// (Left in place but now unused; safe no-op)
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

// Inject CSS for indeterminate bar (one-time, non-invasive)
(function ensureIndeterminateStyle() {
  if (document.getElementById("hf-indeterminate-style")) return;
  const style = document.createElement("style");
  style.id = "hf-indeterminate-style";
  style.textContent = `
@keyframes hfIndeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
.hf-track {
  position: relative;
  height: 10px;
  background: #333;
  border-radius: 5px;
  overflow: hidden;
  width: 100%;
}
.hf-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 35%;
  background: #0084ff;
  border-radius: 5px;
  animation: hfIndeterminate 1.2s linear infinite;
}
`;
  document.head.appendChild(style);
})();

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    const wrap = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", padding: "10px" } });

    // Inputs (unchanged)
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

    // Indeterminate progress (replaces the old determinate progressFill)
    const progressTrack = el("div", { className: "hf-track", style: { display: "none" } });
    const progressIndet = el("div", { className: "hf-bar" });
    progressTrack.append(progressIndet);

    const statusText = el("div", {
      style: { fontSize: "12px", color: "#ccc", minHeight: "16px", textAlign: "center" },
      textContent: "Ready"
    });

    // Buttons (unchanged)
    const buttonRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "center" } });
    const downloadBtn = el("button", { textContent: "Download", style: { padding: "6px 12px", cursor: "pointer" } });
    const stopBtn = el("button", { textContent: "Stop", disabled: true, style: { padding: "6px 12px", cursor: "pointer" } });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(repoInput, fileInput, destInput, progressTrack, statusText, buttonRow);

    // DOM widget (unchanged)
    node.addDOMWidget("hf_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => wrap.offsetHeight || 200
    });

    // Keep your width tweak (unchanged)
    const defaultWidth = node.size[0] || 300;
    node.size[0] = defaultWidth + 50;

    // State (unchanged fields, but simplified logic)
    node.gid = null;
    node._pollInterval = null;
    node._pollCount = 0;

    function showBar(on) {
      progressTrack.style.display = on ? "" : "none";
    }

    function resetUI() {
      downloadBtn.disabled = false;
      stopBtn.disabled = true;
      showBar(false);
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
        if (!node.gid || node._pollCount > 200) { // ~3 minutes as before
          resetUI();
          return;
        }
        node._pollCount++;

        try {
          const response = await fetch(`/hf/status?gid=${encodeURIComponent(node.gid)}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" }
          });
          if (!response.ok) throw new Error(`Status request failed: ${response.status}`);

          const status = await response.json();

          if (status.error) {
            statusText.textContent = `Error: ${status.error}`;
            resetUI();
            return;
          }

          // Only two states now: running vs terminal; no %/speed/ETA
          const running = (status.state === "running" || status.state === "starting" || status.status === "running" || status.status === "starting");
          const done    = (status.state === "done" || status.status === "complete");
          const stopped = (status.state === "stopped" || status.status === "stopped");
          const error   = (status.state === "error" || status.status === "error");

          if (running) {
            statusText.textContent = "Download started...";
            showBar(true);
            return;
          }

          if (done) {
            statusText.textContent = "✅ File download complete";
            showBar(false);
            resetUI();
            return;
          }

          if (stopped) {
            statusText.textContent = "Download stopped";
            showBar(false);
            resetUI();
            return;
          }

          if (error) {
            statusText.textContent = `Download failed${status.msg ? `: ${status.msg}` : ""}`;
            showBar(false);
            resetUI();
            return;
          }
        } catch (err) {
          console.warn("Status poll failed:", err);
          if (node._pollCount > 10) {
            statusText.textContent = `Error: Status check failed - ${err.message}`;
            showBar(false);
            resetUI();
          }
        }
      }, 1000);
    }

    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();

      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill all fields";
        showBar(false);
        return;
      }

      downloadBtn.disabled = true;
      stopBtn.disabled = false;
      statusText.textContent = "Starting download...";
      showBar(false);

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
          showBar(false);
          downloadBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }

        node.gid = result.gid;
        statusText.textContent = "Download started...";
        showBar(true);
        startPolling();
      } catch (error) {
        statusText.textContent = `Failed to start: ${error.message}`;
        showBar(false);
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
        showBar(false);
      } catch (error) {
        console.warn("Stop request failed:", error);
        statusText.textContent = `Error stopping: ${error.message}`;
      }
      resetUI();
    };

    // Cleanup (unchanged)
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      resetUI();
      if (wrap && wrap.parentNode) wrap.remove();
      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
