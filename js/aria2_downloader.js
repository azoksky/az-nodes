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
      this.addWidget("text", "URL", this.properties.url, v => this.properties.url = v ?? "");
      
      const destW = this.addWidget("text","Destination Folder", this.properties.dest_dir, v => this.properties.dest_dir = v ?? "");
      setTimeout(() => {
              try {
                    addPathDropdown(this, destW, "/aria2/suggest");
                  } catch (e) {
                  console.warn("Dropdown init failed:", e);}}, 0);
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

