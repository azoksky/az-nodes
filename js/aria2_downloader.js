app.registerExtension({
  name: "aznodes.aria2_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "Aria2Downloader") return;

    // Ensure default properties
    node.properties = node.properties || {};
    node.properties.url = node.properties.url || "";
    node.properties.token = node.properties.token || "";
    node.properties.dest_dir = (node.properties.dest_dir || "").replace(/\\/g, "/");

    // Container for all UI elements
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      width: "100%",
      padding: "10px",
      boxSizing: "border-box",
    });

    // Destination folder input with autocomplete
    const destInput = document.createElement("input");
    destInput.type = "text";
    destInput.placeholder = "Destination folder (e.g. C:/Users/you/Downloads or ~/models)";
    Object.assign(destInput.style, {
      width: "100%",
      padding: "4px",
      boxSizing: "border-box",
    });
    destInput.value = node.properties.dest_dir;
    wrap.append(destInput);

    // Dropdown menu for folder suggestions
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
      boxShadow: "0 8px 16px rgba(0,0,0,0.35)",
      zIndex: "999999",
      minWidth: "180px",
    });
    document.body.append(dropdown);

    const normalizePath = (p) => (p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const joinPath = (base, seg) => {
      base = normalizePath(base);
      seg = normalizePath(seg);
      if (!base) return seg;
      if (!seg) return base;
      return (base.endsWith("/") ? base : base + "/") + seg;
    };

    let items = [], active = -1;
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
          userSelect: "none",
        });
        row.onmouseenter = () => { active = idx; renderDropdown(); };
        const choose = () => {
          const chosen = normalizePath(it.path);
          destInput.value = chosen;
          node.properties.dest_dir = chosen;
          items = []; active = -1;
          dropdown.style.display = "none";
          fetchDirectory();
        };
        row.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); choose(); });
        row.addEventListener("mousedown",   (e) => { e.preventDefault(); e.stopPropagation(); choose(); });
        dropdown.append(row);
      });
      // Position dropdown under input
      const r = destInput.getBoundingClientRect();
      dropdown.style.left = `${r.left}px`;
      dropdown.style.top = `${r.bottom + 2}px`;
      dropdown.style.width = `${r.width}px`;
      dropdown.style.display = "block";
    };

    const fetchDirectory = async () => {
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

    destInput.addEventListener("input", () => {
      const raw = destInput.value;
      const prev = destInput.selectionStart;
      const norm = normalizePath(raw);
      if (norm !== raw) {
        const delta = norm.length - raw.length;
        destInput.value = norm;
        destInput.setSelectionRange(prev + delta, prev + delta);
      }
      node.properties.dest_dir = destInput.value;
      fetchDirectory();
    });
    destInput.addEventListener("focus", () => { fetchDirectory(); });
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
        const it = items[active];
        destInput.value = normalizePath(it.path);
        node.properties.dest_dir = destInput.value;
        items = []; active = -1;
        dropdown.style.display = "none";
        fetchDirectory();
      } else if (e.key === "Escape") {
        dropdown.style.display = "none";
        items = [];
        active = -1;
      }
    });
    destInput.addEventListener("blur", () => { 
      setTimeout(() => { dropdown.style.display = "none"; }, 100); 
    });

    // URL input
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.placeholder = "URL";
    Object.assign(urlInput.style, {
      width: "100%",
      padding: "4px",
      boxSizing: "border-box",
    });
    urlInput.value = node.properties.url;
    urlInput.addEventListener("input", () => {
      node.properties.url = urlInput.value;
    });
    wrap.append(urlInput);

    // Secret token input
    const tokenInput = document.createElement("input");
    tokenInput.type = "text";
    tokenInput.placeholder = "SECRET TOKEN";
    Object.assign(tokenInput.style, {
      width: "100%",
      padding: "4px",
      boxSizing: "border-box",
    });
    tokenInput.value = node.properties.token;
    tokenInput.addEventListener("input", () => {
      node.properties.token = tokenInput.value;
    });
    wrap.append(tokenInput);

    // Download button
    const button = document.createElement("button");
    button.textContent = "Download";
    button.style.padding = "6px 12px";
    button.style.cursor = "pointer";
    wrap.append(button);

    // Add our container to the node UI
    node.addDOMWidget("aria2_downloader", "dom", wrap, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => 300,
    });

    // Initialize download state
    node.gid = null;
    node._status = "Idle";
    node._progress = 0;
    node._speed = 0;
    node._eta = null;
    node._filename = "";
    node._filepath = "";

    // Canvas for progress bar and status text
    node.size = [460, 300];
    node.onDrawForeground = (ctx) => {
      const pad = 10;
      const w = node.size[0] - pad * 2;
      const barH = 14;
      const yBar = node.size[1] - pad - barH - 4;
      // Status text
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "#bbb";
      const meta = `Status: ${node._status}   •   Speed: ${node._speed > 0 ? (node._speed) : 0} B/s   •   ETA: ${node._eta != null ? node._eta + "s" : "—"}`;
      ctx.fillText(meta, pad, yBar - 26);
      // Filename if available
      if (node._filename || node._filepath) {
        const show = node._filepath || node._filename;
        ctx.fillStyle = "#8fa3b7";
        ctx.fillText(`Saved as: ${show}`, pad, yBar - 10);
      }
      // Draw progress bar outline
      const radius = 7;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#666";
      ctx.beginPath();
      ctx.moveTo(pad + radius, yBar);
      ctx.lineTo(pad + w - radius, yBar);
      ctx.quadraticCurveTo(pad + w, yBar, pad + w, yBar + radius);
      ctx.lineTo(pad + w, yBar + barH - radius);
      ctx.quadraticCurveTo(pad + w, yBar + barH, pad + w - radius, yBar + barH);
      ctx.lineTo(pad + radius, yBar + barH);
      ctx.quadraticCurveTo(pad, yBar + barH, pad, yBar + barH - radius);
      ctx.lineTo(pad, yBar + radius);
      ctx.quadraticCurveTo(pad, yBar, pad + radius, yBar);
      ctx.closePath();
      ctx.stroke();
      // Fill progress bar
      const pct = Math.max(0, Math.min(100, node._progress || 0));
      const fillW = Math.round((w * pct) / 100);
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad + 1, yBar + 1, Math.max(0, fillW - 2), barH - 2);
      const grad = ctx.createLinearGradient(pad, yBar, pad, yBar + barH);
      grad.addColorStop(0, "#9ec7ff");
      grad.addColorStop(1, "#4b90ff");
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      // Percent text
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#111";
      ctx.fillText(`${pct.toFixed(0)}%`, pad + w / 2, yBar + barH / 2);
    };

    // Helper for formatting bytes (for completeness)
    function fmtBytes(b) {
      if (!b || b <= 0) return "0 B";
      const u = ["B","KB","MB","GB","TB"];
      const i = Math.floor(Math.log(b)/Math.log(1024));
      return (b/Math.pow(1024,i)).toFixed(i ? 1 : 0) + " " + u[i];
    }
    function fmtETA(s) {
      if (s == null) return "—";
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
      if (h) return `${h}h ${m}m ${sec}s`;
      if (m) return `${m}m ${sec}s`;
      return `${sec}s`;
    }

    // Download button logic
    button.addEventListener("click", async () => {
      if (node.gid) return;
      const url = (node.properties.url || "").trim();
      const dest = (node.properties.dest_dir || "").trim();
      if (!url) {
        node._status = "Missing URL";
        node.setDirtyCanvas(true);
        return;
      }
      node._status = "Starting…";
      node._progress = 0;
      node._speed = 0;
      node._eta = null;
      node._filename = "";
      node._filepath = "";
      node.setDirtyCanvas(true);

      let resp, data;
      try {
        resp = await fetch("/aria2/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, dest_dir: dest, token: node.properties.token || "" }),
        });
        data = await resp.json();
      } catch {
        node._status = "Error (network)";
        node.setDirtyCanvas(true);
        return;
      }
      if (!resp.ok || data.error) {
        node._status = `Error: ${data.error || resp.status}`;
        node.setDirtyCanvas(true);
        return;
      }
      node.gid = data.gid;
      node._status = "Active";
      node.setDirtyCanvas(true);

      // Poll for status
      const poll = async () => {
        if (!node.gid) return;
        let sResp, s;
        try {
          sResp = await fetch(`/aria2/status?gid=${encodeURIComponent(node.gid)}`);
          s = await sResp.json();
        } catch {
          setTimeout(poll, 700);
          return;
        }
        if (s.error) {
          node._status = `Error: ${s.error}`;
          node.gid = null;
          node.setDirtyCanvas(true);
          return;
        }
        node._status = s.status || "active";
        node._progress = s.percent || 0;
        node._speed = s.downloadSpeed || 0;
        node._eta = s.eta || null;
        if (s.filename) node._filename = s.filename;
        if (s.filepath) node._filepath = s.filepath;
        node.setDirtyCanvas(true);
        if (["complete", "error", "removed"].includes(node._status)) {
          node.gid = null;
          return;
        }
        setTimeout(poll, 500);
      };
      poll();
    });

    // Cleanup on node removal
    const oldRemoved = node.onRemoved;
    node.onRemoved = function() {
      clearTimeout(node._pollTimer);
      if (dropdown && dropdown.parentNode) dropdown.remove();
      if (oldRemoved) oldRemoved.call(this);
    };
  }
});
