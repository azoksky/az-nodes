import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Helper to create elements with attributes
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  const { style, ...rest } = attrs;
  if (rest) Object.assign(n, rest);
  if (style) Object.assign(n.style, style);
  for (const c of children) n.append(c);
  return n;
}

// Inject CSS for indeterminate progress bar
(function() {
  const style = document.createElement("style");
  style.textContent = `
@keyframes hfIndeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
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
  background: #0084ff !important;
  opacity: 0.95 !important;
}`;
  document.head.append(style);
})();

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // UI container
    const wrap = el("div", {
      className: "az-hf-hub-downloader",
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        width: "100%",
        padding: "10px",
        boxSizing: "border-box",
      },
    });

    // Input fields
    const repoInput = el("input", {
      type: "text",
      placeholder: "Repository ID (e.g. runwayml/stable-diffusion-v1-5)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });
    const fileInput = el("input", {
      type: "text",
      placeholder: "Filename (e.g. model.safetensors)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });
    const tokenInput = el("input", {
      type: "text",
      placeholder: "Secret Token, if any",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });
    const destInput = el("input", {
      type: "text",
      placeholder: "Destination folder (e.g. ./models)",
      style: { width: "100%", padding: "4px", boxSizing: "border-box" }
    });
    wrap.append(repoInput, tokenInput, fileInput, destInput);

    // Dropdown for dest folder autocomplete
    const dropdown = el("div", {
      style: {
        position: "fixed",
        background: "#222",
        border: "1px solid #555",
        display: "none",
        maxHeight: "200px",
        overflowY: "auto",
        fontSize: "12px",
        borderRadius: "6px",
        boxShadow: "0 8px 16px rgba(0,0,0,0.35)",
        zIndex: "999999",
        minWidth: "180px"
      }
    });
    document.body.append(dropdown);
    const placeDropdown = () => {
      const r = destInput.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top  = `${r.bottom + 2}px`;
      dropdown.style.width = `${r.width}px`;
    };

    // Progress bar and status
    const progressTrack = el("div", { className: "hf-track", style: { display: "none" } });
    const progressIndet = el("div", { className: "hf-bar" });
    progressTrack.append(progressIndet);
    const statusText = el("div", {
      style: { fontSize: "12px", color: "#ccc", minHeight: "16px", textAlign: "center" },
      textContent: "Ready"
    });

    // Buttons
    const buttonRow = el("div", { style: { display: "flex", gap: "8px", justifyContent: "center" } });
    const downloadBtn = el("button", { textContent: "Download", style: { padding: "6px 12px", cursor: "pointer" } });
    const stopBtn = el("button", { textContent: "Stop", disabled: true, style: { padding: "6px 12px", cursor: "pointer" } });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(progressTrack, statusText, buttonRow);

    // Folder autocomplete logic
    let items = [], active = -1;
    const normalizePath = (p) => (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const joinPath = (a, b) => normalizePath((a?.endsWith("/") ? a : a + "/") + (b || ""));
    const renderDropdown = () => {
      dropdown.innerHTML = "";
      if (!items.length) {
        dropdown.style.display = "none";
        active = -1;
        return;
      }
      items.forEach((it, idx) => {
        const row = document.createElement("div");
        row.textContent = it.name;
        Object.assign(row.style, {
          padding: "6px 10px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          background: idx === active ? "#444" : "transparent",
          userSelect: "none"
        });
        row.onmouseenter = () => { active = idx; renderDropdown(); };
        const choose = () => {
          const chosen = normalizePath(it.path);
          destInput.value = chosen;
          node.properties.dest_dir = chosen;
          items = []; active = -1;
          dropdown.style.display = "none";
          scheduleFetch();
        };
        row.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); choose(); });
        row.addEventListener("mousedown",   (e) => { e.preventDefault(); e.stopPropagation(); choose(); });
        dropdown.append(row);
      });
      placeDropdown();
      dropdown.style.display = "block";
    };

    const fetchChildren = async () => {
      const raw = destInput.value.trim();
      if (!raw) { items = []; renderDropdown(); return; }
      const val = normalizePath(raw);
      try {
        const resp = await fetch(`/az/listdir?path=${encodeURIComponent(val)}`);
        const data = await resp.json();
        if (data.ok && Array.isArray(data.folders)) {
          items = data.folders.map(f => ({
            name: f.name,
            path: joinPath(data.root || val, f.name)
          }));
        } else {
          items = [];
        }
      } catch {
        items = [];
      }
      active = items.length ? 0 : -1;
      renderDropdown();
    };

    const scheduleFetch = () => {
      if (items) clearTimeout(items);
      items = setTimeout(fetchChildren, 180);
    };

    destInput.addEventListener("input", () => {
      const raw = destInput.value;
      const prevStart = destInput.selectionStart;
      const norm = normalizePath(raw);
      if (norm !== raw) {
        const delta = norm.length - raw.length;
        destInput.value = norm;
        destInput.setSelectionRange((prevStart || 0) + delta, (prevStart || 0) + delta);
      }
      node.properties.dest_dir = normalizePath(destInput.value);
      placeDropdown();
      scheduleFetch();
    });
    destInput.addEventListener("focus", () => { placeDropdown(); scheduleFetch(); });
    destInput.addEventListener("keydown", (e) => {
      if (dropdown.style.display !== "block" || !items.length) return;
      if (e.key === "ArrowDown") { 
        e.preventDefault();
        active = (active + 1) % items.length;
        renderDropdown();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = (active - 1 + items.length) % items.length;
        renderDropdown();
      } else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        destInput.value = normalizePath(items[active].path);
        node.properties.dest_dir = destInput.value;
        items = []; active = -1;
        dropdown.style.display = "none";
        scheduleFetch();
      } else if (e.key === "Escape") {
        dropdown.style.display = "none";
        items = [];
        active = -1;
      }
    });
    destInput.addEventListener("blur", () => {
      setTimeout(() => { dropdown.style.display = "none"; }, 120);
    });

    // Add DOM widget
    const MIN_W = 460, MIN_H = 230;
    node.addDOMWidget("hf_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => MIN_H
    });

    // Enforce minimum size
    node.size = [
      Math.max(node.size[0] || MIN_W, MIN_W),
      Math.max(node.size[1] || MIN_H, MIN_H),
    ];
    const prevOnResize = node.onResize;
    node.onResize = function() {
      this.size[0] = Math.max(this.size[0], MIN_W);
      this.size[1] = Math.min(Math.max(this.size[1], MIN_H), 300);
      if (prevOnResize) prevOnResize.apply(this, arguments);
    };

    // Download state
    node.gid = null;
    node._pollInterval = null;
    node._pollCount = 0;

    function showBar(on) {
      progressTrack.style.display = on ? "block" : "none";
    }
    function setButtons(running) {
      downloadBtn.disabled = !!running;
      stopBtn.disabled = !running;
    }
    function resetToIdle(msg = "Ready") {
      setButtons(false);
      showBar(false);
      statusText.textContent = msg;
      node.gid = null;
      clearInterval(node._pollInterval);
      node._pollInterval = null;
      node._pollCount = 0;
    }
    function startPolling() {
      clearInterval(node._pollInterval);
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
            clearInterval(node._pollInterval);
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

    // Download button click
    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();
      const token_val = tokenInput.value.trim();
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
          body: JSON.stringify({ repo_id, filename, dest_dir, token_input: token_val })
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

    // Stop button click
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

    // Initialize UI state
    node.size[0] = Math.max(node.size[0], MIN_W);
    resetToIdle("Ready");

    // Cleanup on removal
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      clearInterval(node._pollInterval);
      dropdown.remove();
      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
