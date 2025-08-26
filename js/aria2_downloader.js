// Loaded via WEB_DIRECTORY from this custom node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* ============ Small helpers ============ */
function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtETA(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.floor(s % 60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/* ============ Lightweight dropdown like js/path_uploader.js ============ */
class PathDropdown {
  constructor(textWidget, opts = {}) {
    this.widget = textWidget; // a LiteGraph text widget
    this.inputEl = null; // will be resolved after first draw
    this.endpoint = opts.endpoint || "/aria2/suggest";
    this.minChars = opts.minChars ?? 0;
    this.maxItems = opts.maxItems ?? 50;
    this.debounceMs = opts.debounceMs ?? 120;

    this.menu = null;
    this.items = [];
    this.active = -1;
    this._debounce = null;

    this._bindAfterAttach();
  }

  _bindAfterAttach() {
    // Comfy/LiteGraph only creates <input> after the first draw. Observe DOM.
    const mo = new MutationObserver(() => {
      const candidate = document.querySelector("input.comfy-text-input");
      if (!candidate) return;
      // find the input that belongs to our widget by placeholder/value match
      if (!this.inputEl && candidate.closest(".litegraph")) {
        // Heuristic: attach to the LAST focused comfy input
        setTimeout(() => {
          const inputs = document.querySelectorAll("input.comfy-text-input");
          const el = inputs[inputs.length - 1];
          if (el && !this.inputEl) {
            this._attach(el);
            mo.disconnect();
          }
        }, 0);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  _attach(input) {
    this.inputEl = input;
    // wrap for positioning
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    // dropdown container
    const menu = document.createElement("div");
    menu.style.position = "absolute";
    menu.style.zIndex = 10000;
    menu.style.left = "0";
    menu.style.right = "0";
    menu.style.top = "calc(100% + 4px)";
    menu.style.maxHeight = "260px";
    menu.style.overflowY = "auto";
    menu.style.display = "none";
    menu.style.background = "var(--comfy-menu-bg, #1e1f22)";
    menu.style.color = "#e6e6e6";
    menu.style.border = "1px solid rgba(255,255,255,.08)";
    menu.style.borderRadius = "8px";
    menu.style.boxShadow = "0 8px 24px rgba(0,0,0,.35)";
    menu.style.padding = "6px";
    this.menu = menu;
    wrapper.appendChild(menu);

    // listeners
    input.addEventListener("input", () => this._onInput());
    input.addEventListener("keydown", (e) => this._onKeyDown(e));
    document.addEventListener("click", (e) => {
      if (e.target === input || this.menu.contains(e.target)) return;
      this._hide();
    });

    // immediately normalize slashes while typing
    input.addEventListener("input", () => {
      const v = input.value;
      const nv = v.replace(/\\+/g, "/");
      if (v !== nv) {
        const pos = input.selectionStart;
        input.value = nv;
        input.setSelectionRange(pos, pos);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  _onInput() {
    const q = (this.inputEl.value || "").trim();
    if (q.length < this.minChars) {
      this._hide();
      return;
    }
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this._fetch(q), this.debounceMs);
  }

  async _fetch(prefix) {
    try {
      const r = await api.fetchApi(
        `${this.endpoint}?prefix=${encodeURIComponent(prefix)}`
      );
      const data = await r.json();
      const items = (Array.isArray(data) ? data : data.items) || [];
      this.items = items.slice(0, this.maxItems);
      this.active = this.items.length ? 0 : -1;
      this._render();
    } catch {
      this.items = [];
      this.active = -1;
      this._render();
    }
  }

  _render() {
    const m = this.menu;
    if (!m) return;
    m.innerHTML = "";

    const arr = this.items;
    if (!arr.length) {
      const empty = document.createElement("div");
      empty.textContent = "No matches";
      empty.style.opacity = "0.7";
      empty.style.fontSize = "12.5px";
      empty.style.padding = "8px";
      m.appendChild(empty);
      this._show();
      return;
    }

    arr.forEach((val, i) => {
      const item = document.createElement("div");
      item.textContent = val;
      item.title = val;
      item.style.cursor = "pointer";
      item.style.userSelect = "none";
      item.style.padding = "8px 10px";
      item.style.borderRadius = "6px";
      item.style.whiteSpace = "nowrap";
      item.style.overflow = "hidden";
      item.style.textOverflow = "ellipsis";
      if (i === this.active) item.style.background = "rgba(255,255,255,.08)";

      item.addEventListener("mouseenter", () => {
        this.active = i;
        [...m.children].forEach((c, idx) => {
          c.style.background = idx === this.active ? "rgba(255,255,255,.08)" : "transparent";
        });
      });
      // prevent blur so click sets value
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => this._choose(val));
      m.appendChild(item);
    });

    this._show();
  }

  _show() {
    if (this.menu) this.menu.style.display = "block";
  }
  _hide() {
    if (this.menu) this.menu.style.display = "none";
  }

  _choose(v) {
    const normalized = String(v || "").replace(/\\+/g, "/");
    this.inputEl.value = normalized;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    this._hide();
  }

  _onKeyDown(e) {
    if (!this.menu || this.menu.style.display === "none") return;
    const max = this.items.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = Math.min(max, this.active + 1);
      this._render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = Math.max(0, this.active - 1);
      this._render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (this.active >= 0 && this.active <= max) {
        e.preventDefault();
        this._choose(this.items[this.active]);
      }
    } else if (e.key === "Escape") {
      this._hide();
    }
  }
}

/* ============ Node registration ============ */
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

      // Inputs
      const urlW = this.addWidget("text", "URL", this.properties.url, (v) => (this.properties.url = v ?? ""));
      const destW = this.addWidget("text", "Destination Folder", this.properties.dest_dir, (v) => (this.properties.dest_dir = v ?? ""));

      // Attach dropdown to Destination folder (mirrors path_uploader)
      setTimeout(() => {
        try {
          new PathDropdown(destW, { endpoint: "/aria2/suggest" });
        } catch {}
      }, 0);

      // State
      this.gid = null;
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._pollTimer = null;
      this._filename = "";
      this._filepath = "";

      // Download button (no queue)
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;

        const url = (this.properties.url || "").trim();
        const dest = (this.properties.dest_dir || "").trim().replace(/\\+/g, "/");
        if (!url) {
          this._status = "Missing URL";
          this.setDirtyCanvas(true);
          return;
        }

        this._status = "Starting…";
        this._progress = 0;
        this._speed = 0;
        this._eta = null;
        this._filename = "";
        this._filepath = "";
        this.setDirtyCanvas(true);

        let resp, data;
        try {
          resp = await api.fetchApi("/aria2/start", {
            method: "POST",
            body: JSON.stringify({ url, dest_dir: dest }),
          });
          data = await resp.json();
        } catch {
          this._status = "Error (network)";
          this.setDirtyCanvas(true);
          return;
        }

        if (!resp.ok || data?.error) {
          this._status = `Error: ${data?.error || resp.status}`;
          this.setDirtyCanvas(true);
          return;
        }

        this.gid = data.gid;
        this._status = "Active";
        this.setDirtyCanvas(true);

        const poll = async () => {
          if (!this.gid) return;
          let sResp, s;
          try {
            sResp = await api.fetchApi(`/aria2/status?gid=${encodeURIComponent(this.gid)}`);
            s = await sResp.json();
          } catch {
            this._pollTimer = setTimeout(poll, 700);
            return;
          }

          if (s?.error) {
            this._status = `Error: ${s.error}`;
            this.gid = null;
            this.setDirtyCanvas(true);
            return;
          }

          this._status = s.status || "active";
          this._progress = s.percent ?? 0;
          this._speed = s.downloadSpeed ?? 0;
          this._eta = s.eta ?? null;

          if (s.filename) this._filename = s.filename;
          if (s.filepath) this._filepath = s.filepath;

          this.setDirtyCanvas(true);

          if (["complete", "error", "removed"].includes(this._status)) {
            this.gid = null;
            return;
          }
          this._pollTimer = setTimeout(poll, 500);
        };

        poll();
      });

      // Canvas size & progress UI
      this.size = [460, 200];
      this.onDrawForeground = (ctx) => {
        const pad = 10;
        const w = this.size[0] - pad * 2;
        const barH = 14;
        const yBar = this.size[1] - pad - barH - 4;

        // Status
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "#bbb";
        const meta = `Status: ${this._status}   •   Speed: ${fmtBytes(this._speed)}/s   •   ETA: ${fmtETA(this._eta)}`;
        ctx.fillText(meta, pad, yBar - 26);

        // Filename/path
        if (this._filename || this._filepath) {
          const show = this._filepath || this._filename;
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText(`Saved as: ${show}`, pad, yBar - 10);
        }

        // Bar outline
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

        // Fill
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

        // % label
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#111";
        ctx.fillText(`${pct.toFixed(0)}%`, pad + w / 2, yBar + barH / 2);
      };

      // Cleanup
      const oldRemoved = this.onRemoved;
      this.onRemoved = function () {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        if (oldRemoved) oldRemoved.apply(this, arguments);
      };

      return r;
    };
  },
});
