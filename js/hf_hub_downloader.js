import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  const { style, ...rest } = attrs || {};
  if (rest) Object.assign(n, rest);
  if (style && typeof style === "object") Object.assign(n.style, style);
  for (const c of children) n.append(c);
  return n;
}

// Inject CSS for indeterminate bar (scoped + forced blue)
(function ensureIndeterminateStyle() {
  let style = document.getElementById("hf-indeterminate-style");
  if (style) return;
  style = document.createElement("style");
  style.id = "hf-indeterminate-style";
  style.textContent = `
@keyframes hfIndeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
/* Scoped to our wrapper */
.az-hf-hub-downloader .hf-track {
  position: relative !important;
  height: 12px !important;
  background: #222 !important;
  border-radius: 6px !important;
  overflow: hidden !important;
  width: 100% !important;
}
.az-hf-hub-downloader .hf-bar {
  position: absolute !important;
  inset: 0 auto 0 0 !important;
  width: 36% !important;
  border-radius: 6px !important;
  animation: hfIndeterminate 1.1s linear infinite !important;
  background: #0084ff !important;   /* force the blue */
  opacity: 0.95 !important;
}
`;
  document.head.appendChild(style);
})();

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // ====== UI (DOM) ======
    const wrap = el("div", {
      className: "az-hf-hub-downloader",  // scope for CSS
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        width: "100%",
        padding: "10px",
        boxSizing: "border-box",
      }
    });

    const repoInput = el("input", {
      type: "text",
      placeholder: "Repository ID (e.g. runwayml/stable-diffusion-v1-5)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });
    
    const tokenInput = el("input", {
      type: "text",
      placeholder: "Secret Token, if any",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const fileInput = el("input", {
      type: "text",
      placeholder: "Filename (e.g. model.safetensors)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    const destInput = el("input", {
      type: "text",
      placeholder: "Destination folder (e.g. ./models)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });

    // Indeterminate progress bar
    const progressTrack = el("div", { className: "hf-track", style: { display: "none" } });
    const progressIndet = el("div", { className: "hf-bar" });
    progressTrack.append(progressIndet);

    const statusText = el("div", {
      style: { fontSize: "12px", color: "#ccc", minHeight: "16px", textAlign: "center" },
      textContent: "Ready"
    });

    const buttonRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "center" } });
    const downloadBtn = el("button", { textContent: "Download", style: { padding: "6px 12px", cursor: "pointer" } });
    const stopBtn = el("button", { textContent: "Stop", disabled: true, style: { padding: "6px 12px", cursor: "pointer" } });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(repoInput, tokenInput, fileInput, destInput, progressTrack, statusText, buttonRow);

    // Add DOM widget with fixed min height
    const MIN_W = 460;
    const MIN_H = 190;
    node.addDOMWidget("hf_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => MIN_H
    });

    // ====== Size fixes ======
    const MAX_H = 300;
    node.size = [
      Math.max(node.size?.[0] || MIN_W, MIN_W),
      Math.max(node.size?.[1] || MIN_H, MIN_H),
    ];
    const prevOnResize = node.onResize;
    node.onResize = function() {
      this.size[0] = Math.max(this.size[0], MIN_W);
      this.size[1] = Math.min(Math.max(this.size[1], MIN_H), MAX_H);
      if (prevOnResize) prevOnResize.apply(this, arguments);
    };

    // ====== State ======
    node.gid = null;
    node._pollInterval = null;
    node._pollCount = 0;

    function showBar(on) {
      progressTrack.style.display = on ? "block" : "none"; // force block
    }
    function setButtons(running) {
      downloadBtn.disabled = !!running;
      stopBtn.disabled = !running;
    }
    function stopPolling() {
      if (node._pollInterval) {
        clearInterval(node._pollInterval);
        node._pollInterval = null;
      }
    }
    function resetToIdle(msg = "Ready") {
      setButtons(false);
      showBar(false);
      statusText.textContent = msg;
      node.gid = null;
      stopPolling();
      node._pollCount = 0;
    }

    function startPolling() {
      stopPolling();
      node._pollCount = 0;
      node._pollInterval = setInterval(async () => {
        if (!node.gid || node._pollCount > 200) {
          resetToIdle("Ready");
          return;
        }
        node._pollCount++;
        try {
          const res = await fetch(`/hf/status?gid=${encodeURIComponent(node.gid)}`, { method: "GET" });
          if (!res.ok) throw new Error(`Status ${res.status}`);
          const st = await res.json();
          if (st.error) {
            resetToIdle(`Error: ${st.error}`);
            return;
          }
          const state = st.state || st.status;
          if (state === "starting" || state === "running") {
            statusText.textContent = st.msg || "Download started...";
            showBar(true);
            setButtons(true);
            return;
          }
          if (state === "done" || state === "complete") {
            statusText.textContent = st.msg ? `✅ ${st.msg}` : "✅ File download complete";
            showBar(false);
            setButtons(false);
            node.gid = null;
            stopPolling();
            return;
          }
          if (state === "stopped") {
            resetToIdle(st.msg || "Stopped.");
            return;
          }
          if (state === "error") {
            resetToIdle(st.msg ? `Error: ${st.msg}` : "Error.");
            return;
          }
        } catch (e) {
          console.warn("Status poll failed:", e);
          if (node._pollCount > 10) {
            resetToIdle(`Error: ${e.message}`);
          }
        }
      }, 1000);
    }

    // ====== Buttons ======
    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();
      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill all fields";
        showBar(false);
        return;
      }
      setButtons(true);
      statusText.textContent = "Starting download...";
      showBar(false);
      try {
        const res = await fetch("/hf/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_id, filename, dest_dir })
        });
        if (!res.ok) throw new Error(`Start ${res.status}`);
        const out = await res.json();
        if (out.error) {
          resetToIdle(`Error: ${out.error}`);
          return;
        }
        node.gid = out.gid;
        statusText.textContent = "Download started...";
        showBar(true);
        startPolling();
      } catch (e) {
        resetToIdle(`Failed to start: ${e.message}`);
      }
    };

    stopBtn.onclick = async () => {
      if (!node.gid) {
        resetToIdle("Stopped.");
        return;
      }
      try {
        await fetch("/hf/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gid: node.gid })
        });
        resetToIdle("Stopped.");
      } catch (e) {
        resetToIdle(`Error stopping: ${e.message}`);
      }
    };

    // ====== Init ======
    node.size[0] = Math.max(node.size[0], MIN_W);
    resetToIdle("Ready");

    // Cleanup
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      stopPolling();
      if (wrap && wrap.parentNode) wrap.remove();
      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
