// Loaded via WEB_DIRECTORY from this custom node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* ---------- utils ---------- */
function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i];
}
function fmtETA(s) {
  if (s == null) return "—";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ---------- DOM dropdown anchored to the existing widget (no new input) ---------- */
function createDropdownContainer(node, widget) {
  // anchor a DOM container under the widget using ComfyUI's DOM widget system
  const dom = node.addDOMWidget?.(widget.name + "_dropdown", "div", null, {
    parentWidget: widget,
    getValue: () => null,
    setValue: () => {},
  });
  const el = dom?.el || document.createElement("div");
  // style like your path_uploader.js
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.right = "0";
  el.style.top = "calc(100% + 4px)";
  el.style.zIndex = 10000;
  el.style.display = "none";
  el.style.maxHeight = "260px";
  el.style.overflowY = "auto";
  el.style.padding = "6px";
  el.style.border = "1px solid rgba(255,255,255,.08)";
  el.style.borderRadius = "8px";
  el.style.background = "var(--comfy-menu-bg, #1e1f22)";
  el.style.color = "#e6e6e6";
  el.style.boxShadow = "0 8px 24px rgba(0,0,0,.35)";
  return el;
}

function attachPathDropdown(node, widget, { endpoint = "/aria2/suggest" } = {}) {
  const menu = createDropdownContainer(node, widget);
  let items = [];
  let active = -1;
  let open = false;
  let debounce;

  function show() {
    if (!open) {
      menu.style.display = "block";
      open = true;
    }
  }
  function hide() {
    if (open) {
      menu.style.display = "none";
      open = false;
    }
  }
  function render() {
    menu.innerHTML = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.textContent = "No matches";
      d.style.opacity = "0.7";
      d.style.fontSize = "12.5px";
      d.style.padding = "8px";
      menu.appendChild(d);
      show();
      return;
    }
    items.forEach((val, i) => {
      const it = document.createElement("div");
      it.textContent = val;
      it.title = val;
      it.style.padding = "8px 10px";
      it.style.borderRadius = "6px";
      it.style.cursor = "pointer";
      it.style.whiteSpace = "nowrap";
      it.style.overflow = "hidden";
      it.style.textOverflow = "ellipsis";
      it.style.userSelect = "none";
      it.style.background = i === active ? "rgba(255,255,255,.08)" : "transparent";

      it.addEventListener("mouseenter", () => {
        active = i;
        [...menu.children].forEach((c, idx) => {
          c.style.background = idx === active ? "rgba(255,255,255,.08)" : "transparent";
        });
      });
      it.addEventListener("mousedown", (e) => e.preventDefault()); // keep widget focus
      it.addEventListener("click", () => {
        const normalized = String(val || "").replace(/\\+/g, "/");
        widget.value = normalized;
        // trigger Comfy widget callback + redraw
        widget.callback?.(normalized, app.canvas);
        node.setDirtyCanvas(true);
        hide();
      });
      menu.appendChild(it);
    });
    show();
  }

  async function query(prefix) {
    try {
      const r = await api.fetchApi(`${endpoint}?prefix=${encodeURIComponent(prefix)}`);
      const data = await r.json();
      items = (Array.isArray(data) ? data : data.items) || [];
      active = items.length ? 0 : -1;
      render();
    } catch {
      items = [];
      active = -1;
      render();
    }
  }

  // 1) When user types in the SAME text widget, we react.
  const origCb = widget.callback;
  widget.callback = (v) => {
    // live normalize slashes without spawning any new editor
    if (typeof v === "string") {
      const nv = v.replace(/\\+/g, "/");
      if (nv !== v) {
        widget.value = nv;
        // call the old callback with normalized value
        origCb?.(nv, app.canvas);
      } else {
        origCb?.(v, app.canvas);
      }
      // debounce fetch
      clearTimeout(debounce);
      const q = (widget.value || "").trim();
      if (!q.length) {
        hide();
        return;
      }
      debounce = setTimeout(() => query(q), 120);
    } else {
      origCb?.(v, app.canvas);
    }
    node.setDirtyCanvas(true);
  };

  // 2) Keyboard navigation while dropdown is open
  const keyHandler = (e) => {
    if (!open) return;
    const max = items.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault(); active = Math.min(max, active + 1); render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); active = Math.max(0, active - 1); render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (active >= 0 && active <= max) {
        e.preventDefault();
        const val = items[active];
        const normalized = String(val || "").replace(/\\+/g, "/");
        widget.value = normalized;
        widget.callback?.(normalized, app.canvas);
        node.setDirtyCanvas(true);
        hide();
      }
    } else if (e.key === "Escape") {
      hide();
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  // 3) Click outside to close
  const clickAway = (e) => {
    if (menu.contains(e.target)) return;
    hide();
  };
  document.addEventListener("click", clickAway, true);

  // 4) Cleanup when node removed
  const oldRemoved = node.onRemoved;
  node.onRemoved = function () {
    document.removeEventListener("keydown", keyHandler, true);
    document.removeEventListener("click", clickAway, true);
    if (oldRemoved) oldRemoved.apply(this, arguments);
  };

  // return small controller (optional)
  return { hide, show };
}

/* ---------- Node registration ---------- */
app.registerExtension({
  name: "comfyui.aria2.downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Aria2Downloader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      this.properties = this.properties || {};
      this.properties.url = this.properties.url || "";
      this.properties.dest_dir = this.properties.dest_dir || "";
      this.serialize_widgets = true;

      // Inputs (exact same text widgets as your uploader, no replacement)
      const urlW  = this.addWidget("text", "URL", this.properties.url,  (v)=> this.properties.url = v ?? "");
      const destW = this.addWidget("text", "Destination Folder", this.properties.dest_dir, (v)=> this.properties.dest_dir = v ?? "");

      // Attach dropdown UNDER Destination widget (mirrors path_uploader.js)
      attachPathDropdown(this, destW, { endpoint: "/aria2/suggest" });

      // --- aria2 state ---
      this.gid = null;
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._pollTimer = null;
      this._filename = "";
      this._filepath = "";

      // Button
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;

        const url  = (this.properties.url || "").trim();
        const dest = (this.properties.dest_dir || "").trim().replace(/\\+/g, "/");
        if (!url) { this._status = "Missing URL"; this.setDirtyCanvas(true); return; }

        this._status = "Starting…";
        this._progress = 0; this._speed = 0; this._eta = null;
        this._filename = ""; this._filepath = "";
        this.setDirtyCanvas(true);

        let resp, data;
        try {
          resp = await api.fetchApi("/aria2/start", {
            method: "POST",
            body: JSON.stringify({ url, dest_dir: dest }),
          });
          data = await resp.json();
        } catch {
          this._status = "Error (network)"; this.setDirtyCanvas(true); return;
        }

        if (!resp.ok || data?.error) {
          this._status = `Error: ${data?.error || resp.status}`; this.setDirtyCanvas(true); return;
        }

        this.gid = data.gid;
        this._status = "Active";
        this.setDirtyCanvas(true);

        const poll = async () => {
          if (!this.gid) return;
          try {
            const sResp = await api.fetchApi(`/aria2/status?gid=${encodeURIComponent(this.gid)}`);
            const s = await sResp.json();
            if (s?.error) {
              this._status = `Error: ${s.error}`; this.gid = null; this.setDirtyCanvas(true); return;
            }
            this._status = s.status || "active";
            this._progress = s.percent ?? 0;
            this._speed = s.downloadSpeed ?? 0;
            this._eta = s.eta ?? null;
            if (s.filename) this._filename = s.filename;
            if (s.filepath) this._filepath = s.filepath;
            this.setDirtyCanvas(true);
            if (!["complete", "error", "removed"].includes(this._status)) {
              this._pollTimer = setTimeout(poll, 500);
            } else {
              this.gid = null;
            }
          } catch {
            this._pollTimer = setTimeout(poll, 700);
          }
        };
        poll();
      });

      // Draw progress UI (unchanged)
      this.size = [460, 200];
      this.onDrawForeground = (ctx) => {
        const pad = 10;
        const w = this.size[0] - pad * 2;
        const barH = 14;
        const yBar = this.size[1] - pad - barH - 4;

        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#bbb";
        const meta = `Status: ${this._status}   •   Speed: ${fmtBytes(this._speed)}/s   •   ETA: ${fmtETA(this._eta)}`;
        ctx.fillText(meta, pad, yBar - 26);

        if (this._filename || this._filepath) {
          const show = this._filepath || this._filename;
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText(`Saved as: ${show}`, pad, yBar - 10);
        }

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

        const pct = Math.max(0, Math.min(100, this._progress || 0));
        const fillW = Math.round((w * pct) / 100);
        ctx.save();
        ctx.beginPath();
        ctx.rect(pad + 1, yBar + 1, Math.max(0, fillW - 2), barH - 2);
        const g = ctx.createLinearGradient(pad, yBar, pad, yBar + barH);
        g.addColorStop(0, "#9ec7ff");
        g.addColorStop(1, "#4b90ff");
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();

        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#111";
        ctx.fillText(`${pct.toFixed(0)}%`, pad + w / 2, yBar + barH / 2);
      };

      const oldRemoved = this.onRemoved;
      this.onRemoved = function () {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (oldRemoved) oldRemoved.apply(this, arguments);
      };

      return r;
    };
  },
});
