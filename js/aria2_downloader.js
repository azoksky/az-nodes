// Loaded via WEB_DIRECTORY from this custom node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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

const normalizePath = (p) => (p || "").replace(/\\/g, "/");

app.registerExtension({
  name: "comfyui.aria2.downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Aria2Downloader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      this.properties = this.properties || {};
      this.properties.url = this.properties.url || "";
      this.properties.dest_dir = normalizePath(this.properties.dest_dir || "");
      this.serialize_widgets = true;

      // URL input
      this.addWidget("text", "URL", this.properties.url, v => this.properties.url = v ?? "");

      // ===== Destination input with custom dropdown =====
      const container = document.createElement("div");
      Object.assign(container.style,{ position:"relative", width:"100%" });

      const destInput = document.createElement("input");
      destInput.type="text";
      destInput.placeholder="Destination folder (e.g. C:/Users/you/Downloads or ~/models)";
      Object.assign(destInput.style,{
        width:"100%", height:"26px", padding:"2px 8px",
        border:"1px solid #444", borderRadius:"6px",
        background:"var(--comfy-input-bg, #2a2a2a)", color:"#ddd",
        boxSizing:"border-box", outline:"none"
      });
      destInput.value = this.properties.dest_dir;

      const dropdown = document.createElement("div");
      Object.assign(dropdown.style,{
        position:"absolute", top:"100%", left:"0", right:"0",
        background:"#222", border:"1px solid #555",
        zIndex:"9999", display:"none", maxHeight:"180px",
        overflowY:"auto", fontSize:"12px", borderRadius:"6px"
      });

      container.appendChild(destInput);
      container.appendChild(dropdown);

      const destWidget = this.addDOMWidget("dest_dir","Destination",container);
      destWidget.computeSize = () => [this.size[0]-20, 34];

      let items = [], active = -1, debounceTimer=null;

      const renderDropdown = () => {
        dropdown.innerHTML = "";
        if (!items.length) { dropdown.style.display = "none"; active = -1; return; }

        items.forEach((it, idx)=>{
          const row = document.createElement("div");
          row.textContent = it;
          Object.assign(row.style,{
            padding:"5px 8px", cursor:"pointer", whiteSpace:"nowrap",
            background: idx===active ? "#444" : "transparent",
            userSelect: "none"
          });

          row.onmouseenter = ()=>{ active = idx; renderDropdown(); };

          const choose = () => {
            const chosen = normalizePath(it);
            destInput.value = chosen;
            this.properties.dest_dir = chosen;
            items = []; active = -1;
            dropdown.style.display="none";
          };
          row.addEventListener("pointerdown", (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });
          row.addEventListener("mousedown",   (e)=>{ e.preventDefault(); e.stopPropagation(); choose(); });

          dropdown.appendChild(row);
        });

        dropdown.style.display = "block";
      };

      const scheduleFetch = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchSuggestions, 200);
      };

      const fetchSuggestions = async () => {
        const raw = destInput.value.trim();
        if (!raw) { items = []; renderDropdown(); return; }
        const val = normalizePath(raw);
        try{
          const resp = await api.fetchApi(`/aria2/suggest?prefix=${encodeURIComponent(val)}`);
          const data = await resp.json();
          items = (data?.items)||[];
          active = items.length ? 0 : -1;
          renderDropdown();
        }catch{ items = []; renderDropdown(); }
      };

      destInput.addEventListener("input", ()=>{
        const prevStart = destInput.selectionStart;
        const normalized = normalizePath(destInput.value);
        if (normalized !== destInput.value) {
          destInput.value = normalized;
          destInput.setSelectionRange(prevStart, prevStart);
        }
        this.properties.dest_dir = normalized;
        scheduleFetch();
      });

      destInput.addEventListener("focus", ()=>{ scheduleFetch(); });

      destInput.addEventListener("keydown", (e)=>{
        if (dropdown.style.display !== "block" || !items.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); active = (active+1) % items.length; renderDropdown(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); active = (active-1+items.length) % items.length; renderDropdown(); }
        else if (e.key === "Enter") {
          if (active >= 0) {
            e.preventDefault();
            const chosen = normalizePath(items[active]);
            destInput.value = chosen;
            this.properties.dest_dir = chosen;
            items = []; active = -1; dropdown.style.display="none";
          }
        } else if (e.key === "Escape") { dropdown.style.display="none"; items=[]; active=-1; }
      });

      destInput.addEventListener("blur", ()=>{ setTimeout(()=>{ dropdown.style.display="none"; }, 120); });

      // ====== STATE ======
      this.gid = null;
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._pollTimer = null;
      this._filename = "";
      this._filepath = "";

      // ====== Download button ======
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;

        const url = (this.properties.url || "").trim();
        const dest = (this.properties.dest_dir || "").trim();
        if (!url) { this._status = "Missing URL"; this.setDirtyCanvas(true); return; }

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

      // ====== Canvas drawing ======
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
