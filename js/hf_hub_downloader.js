import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // Container for fields
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      width: "100%",
      padding: "10px",
      boxSizing: "border-box",
    });

    // Repository ID input
    const repoInput = document.createElement("input");
    repoInput.type = "text";
    repoInput.placeholder = "Repository ID (e.g. runwayml/stable-diffusion-v1-5)";
    Object.assign(repoInput.style, {
      width: "100%",
      padding: "8px",
      border: "1px solid #444",
      borderRadius: "6px",
      background: "var(--comfy-input-bg, #2a2a2a)",
      color: "#ddd",
      boxSizing: "border-box",
      outline: "none"
    });

    // File name input
    const fileInput = document.createElement("input");
    fileInput.type = "text";
    fileInput.placeholder = "Filename (e.g. model.safetensors)";
    Object.assign(fileInput.style, {
      width: "100%",
      padding: "8px",
      border: "1px solid #444",
      borderRadius: "6px",
      background: "var(--comfy-input-bg, #2a2a2a)",
      color: "#ddd",
      boxSizing: "border-box",
      outline: "none"
    });

    // Token input (password) with hint
    const tokenContainer = document.createElement("div");
    Object.assign(tokenContainer.style, { display: "flex", alignItems: "center" });
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.placeholder = "Secret Token";
    Object.assign(tokenInput.style, {
      width: "100%",
      padding: "8px",
      border: "1px solid #444",
      borderRadius: "6px",
      background: "var(--comfy-input-bg, #2a2a2a)",
      color: "#ddd",
      boxSizing: "border-box",
      outline: "none"
    });
    tokenContainer.appendChild(tokenInput);
    const tokenHint = document.createElement("span");
    Object.assign(tokenHint.style, { marginLeft: "6px", color: "#888", fontSize: "12px" });
    tokenContainer.appendChild(tokenHint);

    // Destination folder input with dropdown
    const destInput = document.createElement("input");
    destInput.type = "text";
    destInput.placeholder = "Destination folder (e.g. ./models)";
    Object.assign(destInput.style, {
      width: "100%",
      padding: "8px",
      border: "1px solid #444",
      borderRadius: "6px",
      background: "var(--comfy-input-bg, #2a2a2a)",
      color: "#ddd",
      boxSizing: "border-box",
      outline: "none"
    });
    // Dropdown overlay
    const dropdown = document.createElement("div");
    Object.assign(dropdown.style, {
      position: "fixed",
      background: "#222",
      border: "1px solid #555",
      display: "none",
      maxHeight: "200px",
      overflowY: "auto",
      fontSize: "12px",
      borderRadius: "6px",
      boxShadow: "0 8px 16px rgba(0,0,0,.35)",
      zIndex: "999999",
      minWidth: "180px"
    });
    document.body.appendChild(dropdown);

    // Helper to place dropdown
    const placeDropdown = () => {
      const r = destInput.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top = `${r.bottom + 2}px`;
      dropdown.style.width = `${r.width}px`;
    };

    // Append inputs
    wrap.append(repoInput, fileInput, tokenContainer, destInput);

    // Progress bar and status
    const progressTrack = document.createElement("div");
    progressTrack.className = "hf-track";
    Object.assign(progressTrack.style, { display: "none" });
    const progressBar = document.createElement("div");
    progressBar.className = "hf-bar";
    progressTrack.appendChild(progressBar);

    const statusText = document.createElement("div");
    Object.assign(statusText.style, {
      fontSize: "12px",
      color: "#ccc",
      minHeight: "16px",
      textAlign: "center"
    });
    statusText.textContent = "Ready";

    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, { display: "flex", gap: "8px", justifyContent: "center" });
    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "Download";
    Object.assign(downloadBtn.style, { padding: "6px 12px", cursor: "pointer" });
    const stopBtn = document.createElement("button");
    stopBtn.textContent = "Stop";
    stopBtn.disabled = true;
    Object.assign(stopBtn.style, { padding: "6px 12px", cursor: "pointer" });
    buttonRow.append(downloadBtn, stopBtn);

    wrap.append(progressTrack, statusText, buttonRow);
    node.container.appendChild(wrap);

    // Folder autocomplete logic
    let items = [], active = -1, debounceTimer = null;
    const renderDropdown = () => {
      dropdown.innerHTML = "";
      if (!items.length) { dropdown.style.display = "none"; active = -1; return; }
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
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          destInput.value = it.path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
          node.properties.dest_dir = destInput.value;
          items = []; active = -1;
          dropdown.style.display = "none";
          fetchChildren();
        });
        row.onmouseenter = () => { active = idx; renderDropdown(); };
        dropdown.append(row);
      });
      placeDropdown();
      dropdown.style.display = "block";
    };

    const fetchChildren = async () => {
      const raw = destInput.value.trim();
      if (!raw) { items = []; renderDropdown(); return; }
      const val = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      try {
        const resp = await api.fetchApi(`/az/listdir?path=${encodeURIComponent(val)}`);
        const data = await resp.json();
        if (data?.ok && Array.isArray(data.folders)) {
          items = data.folders.map(f => ({ name: f.name, path: ((data.root || val) + "/" + f.name).replace(/\\/g, "/").replace(/\/{2,}/g, "/") }));
        } else {
          items = [];
        }
      } catch {
        items = [];
      }
      active = items.length ? 0 : -1;
      renderDropdown();
    };

    destInput.addEventListener("input", () => {
      const raw = destInput.value;
      const normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
      const prevStart = destInput.selectionStart;
      if (normalized !== raw) {
        const delta = normalized.length - raw.length;
        destInput.value = normalized;
        const pos = Math.max(0, (prevStart || 0) + delta);
        destInput.setSelectionRange(pos, pos);
      }
      node.properties.dest_dir = destInput.value;
      placeDropdown();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchChildren, 180);
    });

    destInput.addEventListener("focus", () => {
      placeDropdown();
      fetchChildren();
    });

    destInput.addEventListener("keydown", (e) => {
      if (dropdown.style.display !== "block" || !items.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; renderDropdown(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; renderDropdown(); }
      else if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        destInput.value = items[active].path;
        node.properties.dest_dir = destInput.value;
        items = []; active = -1;
        dropdown.style.display = "none";
        fetchChildren();
      } else if (e.key === "Escape") {
        dropdown.style.display = "none"; items = []; active = -1;
      }
    });

    destInput.addEventListener("blur", () => {
      setTimeout(() => dropdown.style.display = "none", 120);
    });

    // Fetch token hints and display
    api.fetchApi("/tokens").then(res => res.json()).then(data => {
      const lower = repoInput.value.toLowerCase();
      const useHint = lower.includes("civitai") ? data.civit : data.hf;
      if (useHint) {
        tokenHint.textContent = `••••${useHint}`;
      }
    });

    // Download button logic
    const updateButtons = (downloading) => {
      downloadBtn.disabled = downloading;
      stopBtn.disabled = !downloading;
    };

    const resetStatus = (msg) => {
      statusText.textContent = msg;
      updateButtons(false);
      progressTrack.style.display = "none";
    };

    let pollInterval = null;
    downloadBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();
      const token_value = tokenInput.value.trim();
      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill all fields";
        return;
      }
      statusText.textContent = "Starting download...";
      updateButtons(true);
      progressTrack.style.display = "none";
      try {
        const res = await fetch("/hf/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo_id, filename, dest_dir, token_input: token_value })
        });
        const out = await res.json();
        if (!res.ok || !out.ok) {
          resetStatus(`Error: ${out.error || res.status}`);
          return;
        }
        node.gid = out.gid;
        statusText.textContent = "Download started...";
        progressTrack.style.display = "block";
        // Poll status
        const poll = async () => {
          try {
            const sRes = await fetch(`/hf/status?gid=${encodeURIComponent(node.gid)}`);
            const statusData = await sRes.json();
            if (!statusData.ok) {
              resetStatus(`Error: ${statusData.error || 'Unknown'}`);
              clearInterval(pollInterval);
              return;
            }
            statusText.textContent = statusData.msg;
            if (statusData.state === "done") {
              resetStatus("Download complete.");
              clearInterval(pollInterval);
            }
            if (statusData.state === "error") {
              resetStatus(`Error: ${statusData.msg}`);
              clearInterval(pollInterval);
            }
          } catch {
            // retry
          }
        };
        pollInterval = setInterval(poll, 1000);
      } catch (e) {
        resetStatus(`Failed to start: ${e.message}`);
      }
    };

    stopBtn.onclick = async () => {
      if (!node.gid) {
        resetStatus("Stopped.");
        return;
      }
      try {
        await fetch("/hf/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gid: node.gid })
        });
        resetStatus("Stopped.");
        clearInterval(pollInterval);
      } catch (e) {
        resetStatus(`Error stopping: ${e.message}`);
      }
    };

    // Cleanup on removal
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      clearInterval(pollInterval);
      if (wrap.parentNode) wrap.remove();
      window.removeEventListener("scroll", window.onscroll, true);
      window.removeEventListener("resize", window.onresize);
      try { dropdown.remove(); } catch {}
      if (originalOnRemoved) originalOnRemoved.call(this);
    };
  }
});
