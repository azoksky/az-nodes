import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024; i++;
  }
  const decimals = v < 10 && i > 0 ? 1 : 0;
  return v.toFixed(decimals) + " " + units[i];
}

function fmtETA(sec) {
  if (sec == null || !isFinite(sec)) return "--";
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + s + "s";
  return s + "s";
}

app.registerExtension({
  name: "comfyui.aria2.downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "Aria2Downloader") return;
    const orig = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      // Persisted properties
      this.properties = this.properties || {};
      this.properties.url = this.properties.url || "";
      this.properties.token = this.properties.token || "";
      this.properties.dest_dir = this.properties.dest_dir || "";
      this.serialize_widgets = true;

      // Poll timer holder and token auto-fill state
      this._pollTimer = null;
      this._autoToken = !this.properties.token;

      // --- Destination input with dropdown (portal) ---
      const container = document.createElement("div");
      Object.assign(container.style, { position: "relative", width: "100%" });

      const destInput = document.createElement("input");
      destInput.type = "text";
      destInput.placeholder = "Destination folder (e.g. C:/Users/you/Downloads)";
      Object.assign(destInput.style, {
        width: "100%",
        height: "26px",
        padding: "8px",
        border: "1px solid #444",
        borderRadius: "6px",
        background: "var(--comfy-input-bg, #2a2a2a)",
        color: "#ddd",
        boxSizing: "border-box",
        outline: "none"
      });
      destInput.value = this.properties.dest_dir || "";

      const dropdown = document.createElement("div");
      Object.assign(dropdown.style, {
        position: "fixed",
        background: "#222",
        border: "1px solid #555",
        zIndex: "999999",
        display: "none",
        maxHeight: "200px",
        overflowY: "auto",
        fontSize: "12px",
        borderRadius: "6px",
        minWidth: "180px",
        boxShadow: "0 8px 16px rgba(0,0,0,.35)"
      });
      document.body.appendChild(dropdown);

      const placeDropdown = () => {
        const rct = destInput.getBoundingClientRect();
        dropdown.style.left = rct.left + "px";
        dropdown.style.top = (rct.bottom + 2) + "px";
        dropdown.style.width = rct.width + "px";
      };

      container.appendChild(destInput);
      const destWidget = this.addDOMWidget("dest_dir", "Destination", container);
      destWidget.computeSize = () => [this.size[0] - 20, 34];

      let items = [], active = -1, debounceTimer = null;

      const ensureActiveVisible = () => {
        if (active >= 0 && active < dropdown.children.length) {
          const el = dropdown.children[active];
          const top = el.offsetTop;
          const bottom = top + el.offsetHeight;
          const viewTop = dropdown.scrollTop;
          const viewBottom = viewTop + dropdown.clientHeight;
          if (top < viewTop) {
            dropdown.scrollTop = top;
          } else if (bottom > viewBottom) {
            dropdown.scrollTop = bottom - dropdown.clientHeight;
          }
        }
      };

      const renderDropdown = () => {
        const prevScrollTop = dropdown.scrollTop;
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
          row.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const chosen = it.path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
            destInput.value = chosen;
            this.properties.dest_dir = chosen;
            items = [];
            active = -1;
            dropdown.style.display = "none";
            scheduleFetch();
          });
          row.onmouseenter = () => {
            active = idx;
            renderDropdown();
          };
          dropdown.appendChild(row);
        });
        placeDropdown();
        dropdown.style.display = "block";
        dropdown.scrollTop = prevScrollTop;
        ensureActiveVisible();
      };

      const scheduleFetch = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchChildren, 180);
      };

      const fetchChildren = async () => {
        const raw = destInput.value.trim();
        if (!raw) {
          items = [];
          renderDropdown();
          return;
        }
        const val = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
        try {
          const resp = await api.fetchApi("/az/listdir?path=" + encodeURIComponent(val));
          const data = await resp.json();
          if (data && data.ok && Array.isArray(data.folders)) {
            items = data.folders.map((f) => ({ name: f.name, path: (data.root || val) + "/" + f.name }));
          } else {
            items = [];
          }
        } catch (e) {
          items = [];
        }
        active = items.length ? 0 : -1;
        renderDropdown();
      };

      destInput.addEventListener("input", () => {
        const raw = destInput.value;
        const prevStart = destInput.selectionStart;
        const normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
        if (normalized !== raw) {
          const delta = normalized.length - raw.length;
          destInput.value = normalized;
          const pos = Math.max(0, (prevStart || 0) + delta);
          destInput.setSelectionRange(pos, pos);
        }
        this.properties.dest_dir = destInput.value;
        placeDropdown();
        scheduleFetch();
      });

      destInput.addEventListener("focus", () => {
        placeDropdown();
        scheduleFetch();
      });

      destInput.addEventListener("keydown", (e) => {
        if (dropdown.style.display !== "block" || !items.length) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          active = (active + 1) % items.length;
          renderDropdown();
          ensureActiveVisible();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          active = (active - 1 + items.length) % items.length;
          renderDropdown();
          ensureActiveVisible();
        } else if (e.key === "Enter" && active >= 0) {
          e.preventDefault();
          const it = items[active];
          const chosen = it.path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
          destInput.value = chosen;
          this.properties.dest_dir = chosen;
          items = [];
          active = -1;
          dropdown.style.display = "none";
          scheduleFetch();
        } else if (e.key === "Escape") {
          dropdown.style.display = "none";
          items = [];
          active = -1;
        }
      });

      destInput.addEventListener("blur", () => {
        setTimeout(() => {
          dropdown.style.display = "none";
        }, 120);
      });

      // --- URL input ---
      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.placeholder = "URL";
      Object.assign(urlInput.style, {
        width: "100%",
        height: "26px",
        padding: "8px",
        border: "1px solid #444",
        borderRadius: "6px",
        background: "var(--comfy-input-bg, #2a2a2a)",
        color: "#ddd",
        boxSizing: "border-box",
        outline: "none"
      });
      urlInput.value = this.properties.url || "";
      const urlWidget = this.addDOMWidget("url", "URL", urlInput);
      urlWidget.computeSize = () => [this.size[0] - 20, 34];

      // --- Token input ---
      const tokenInput = document.createElement("input");
      tokenInput.type = "password";
      tokenInput.placeholder = "Secret Token";
      Object.assign(tokenInput.style, {
        width: "100%",
        height: "26px",
        padding: "8px",
        border: "1px solid #444",
        borderRadius: "6px",
        background: "var(--comfy-input-bg, #2a2a2a)",
        color: "#ddd",
        boxSizing: "border-box",
        outline: "none"
      });
      tokenInput.value = this.properties.token || "";
      const tokenWidget = this.addDOMWidget("token", "TOKEN", tokenInput);
      tokenWidget.computeSize = () => [this.size[0] - 20, 34];

      tokenInput.addEventListener("input", () => {
        this._autoToken = false;
        this.properties.token = tokenInput.value;
      });

      // Token hint
      const hintWidget = this.addWidget("info", "Token Hint", "");
      api.fetchApi("/tokens")
        .then((res) => res.json())
        .then((data) => {
          const hints = [];
          if (data && data.hf) hints.push("HF ..." + data.hf);
          if (data && data.civit) hints.push("Civit ..." + data.civit);
          hintWidget.setValue(hints.join("  |  "));
        })
        .catch(() => {});

      // Resolve token for URL and auto-fill if applicable
      let urlDebounce = null;
      const resolveAndApplyToken = async () => {
        const url = (urlInput.value || "").trim();
        if (!url) return;
        try {
          const resp = await api.fetchApi("/tokens/resolve?url=" + encodeURIComponent(url));
          const data = await resp.json();
          const tok = (data && data.token) ? data.token : "";
          if (tok && (this._autoToken || tokenInput.value.trim() === "")) {
            tokenInput.value = tok;
            this.properties.token = tok;
            this._autoToken = true;
          }
        } catch (e) {
          // ignore
        }
      };

      const scheduleResolveToken = () => {
        clearTimeout(urlDebounce);
        urlDebounce = setTimeout(resolveAndApplyToken, 200);
      };

      urlInput.addEventListener("input", () => {
        this.properties.url = urlInput.value;
        scheduleResolveToken();
      });
      urlInput.addEventListener("paste", () => {
        setTimeout(scheduleResolveToken, 0);
      });
      urlInput.addEventListener("blur", () => {
        resolveAndApplyToken();
      });

      // --- Spacer ---
      const spacer = this.addWidget("info", "", "");
      spacer.computeSize = () => [this.size[0] - 20, 10];

      // --- State ---
      this.gid = null;
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._filename = "";
      this._filepath = "";

      // --- Actions ---
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;
        const url = (urlInput.value || "").trim();
        const dest = (this.properties.dest_dir || "").trim();
        if (!url) {
          this._status = "Missing URL";
          this.setDirtyCanvas(true);
          return;
        }
        this._status = "Starting...";
        this._progress = 0; this._speed = 0; this._eta = null;
        this._filename = ""; this._filepath = "";
        this.setDirtyCanvas(true);

        try {
          const resp = await api.fetchApi("/aria2/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url, dest_dir: dest, token: (tokenInput.value || "").trim() })
          });
          const data = await resp.json();
          if (!resp.ok || data.error) {
            this._status = "Error: " + (data.error || resp.status);
            this.setDirtyCanvas(true);
            return;
          }
          this.gid = data.gid;
          this._status = "Active";
          this.setDirtyCanvas(true);

          const poll = async () => {
            if (!this.gid) return;
            try {
              const sResp = await api.fetchApi("/aria2/status?gid=" + encodeURIComponent(this.gid));
              const s = await sResp.json();
              if (s.error) {
                this._status = "Error: " + s.error;
                this.gid = null;
                this.setDirtyCanvas(true);
                return;
              }
              this._status = s.status || "active";
              this._progress = s.percent || 0;
              this._speed = s.downloadSpeed || 0;
              this._eta = s.eta || null;
              if (s.filename) this._filename = s.filename;
              if (s.filepath) this._filepath = s.filepath;
              this.setDirtyCanvas(true);

              if (["complete", "error", "removed"].includes(this._status)) {
                this.gid = null;
                return;
              }
              this._pollTimer = setTimeout(poll, 500);
            } catch (e) {
              this._pollTimer = setTimeout(poll, 500);
            }
          };
          poll();
        } catch (e) {
          this._status = "Error starting download";
          this.setDirtyCanvas(true);
        }
      });

      this.addWidget("button", "Cancel", "Stop", async () => {
        if (!this.gid) return;
        try {
          await api.fetchApi("/aria2/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gid: this.gid })
          });
        } catch (e) {}
      });

      // Canvas size & drawing
      this.size = [480, 360];
      this.onDrawForeground = (ctx) => {
        const pad = 10;
        const w = this.size[0] - pad * 2;
        const barH = 14;
        const yBar = this.size[1] - pad - barH - 4;
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#bbb";
        const meta = "Status: " + this._status + " • Speed: " + fmtBytes(this._speed) + "/s • ETA: " + fmtETA(this._eta);
        ctx.fillText(meta, pad, yBar - 26);
        if (this._filename || this._filepath) {
          const show = this._filepath || this._filename;
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText("Saved as: " + show, pad, yBar - 10);
        }
        // Draw progress bar
        const radius = 7;
        ctx.lineWidth = 1; ctx.strokeStyle = "#666";
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
        // Fill bar
        const pct = Math.max(0, Math.min(100, this._progress || 0));
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
        // Percentage text
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#111";
        ctx.fillText(pct.toFixed(0) + "%", pad + w / 2, yBar + barH / 2);
      };

      // Cleanup on node removal
      const oldRemoved = this.onRemoved;
      this.onRemoved = function () {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (dropdown.parentNode) dropdown.parentNode.removeChild(dropdown);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        if (oldRemoved) oldRemoved.apply(this, arguments);
      };

      function onScroll() { placeDropdown(); }
      function onResize() { placeDropdown(); }
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);

      // Initial token resolve in case URL was persisted
      if (this.properties.url && (!this.properties.token || this._autoToken)) {
        urlInput.value = this.properties.url;
        resolveAndApplyToken();
      }

      return r;
    };
  },
});

