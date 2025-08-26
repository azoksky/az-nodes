// Loaded via WEB_DIRECTORY ("./js") from your package.
// Adds a file picker + destination + progress bar to PathUploader.

import { app } from "../../scripts/app.js";

function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0) + " " + u[i];
}
function fmtETA(secs) {
  if (secs == null) return "—";
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = Math.floor(secs%60);
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

app.registerExtension({
  name: "az.path.uploader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "PathUploader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      // persisted props
      this.properties = this.properties || {};
      this.properties.dest_dir = this.properties.dest_dir || "";

      // state
      this._status = "Idle";
      this._progress = 0; // 0..100
      this._sent = 0;     // bytes
      this._total = 0;    // bytes
      this._speed = 0;    // B/s (rolling)
      this._eta = null;
      this._filename = "";
      this._savedPath = "";
      this._xhr = null;
      this._tPrev = 0;
      this._sentPrev = 0;

      // widgets
      // Destination on server
      this.addWidget("text", "Destination Folder", this.properties.dest_dir, v => {
        this.properties.dest_dir = v ?? "";
      });

      // Choose file button
      this.addWidget("button", "Choose File", "Pick", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.onchange = () => {
          if (!input.files || !input.files[0]) return;
          const f = input.files[0];
          this._filename = f.name;
          this._status = "Ready";
          this._progress = 0; this._sent = 0; this._total = f.size;
          this._speed = 0; this._eta = null; this._savedPath = "";
          this.setDirtyCanvas(true);
          this._selectedFile = f;
        };
        input.click();
      });

      // Upload button
      this.addWidget("button", "Upload", "Start", async () => {
        if (this._xhr || !this._selectedFile) return;
        const f = this._selectedFile;
        const destDir = (this.properties.dest_dir || "").trim();

        const form = new FormData();
        form.append("file", f, f.name);
        if (destDir) form.append("dest_dir", destDir);

        const xhr = new XMLHttpRequest();
        this._xhr = xhr;
        this._status = "Uploading…";
        this._progress = 0;
        this._sent = 0;
        this._total = f.size;
        this._speed = 0; this._eta = null;
        this._savedPath = "";
        this._tPrev = performance.now();
        this._sentPrev = 0;
        this.setDirtyCanvas(true);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            this._sent = e.loaded;
            this._total = e.total;
            this._progress = Math.max(0, Math.min(100, (e.loaded / e.total) * 100));
          } else {
            // fall back: estimate %
            this._sent = e.loaded || this._sent;
            this._progress = this._total ? (this._sent / this._total) * 100 : this._progress;
          }

          const tNow = performance.now();
          const dt = (tNow - this._tPrev) / 1000;
          if (dt > 0.25) {
            const dBytes = this._sent - this._sentPrev;
            this._speed = dBytes / dt; // B/s
            const remain = Math.max(this._total - this._sent, 0);
            this._eta = this._speed > 0 ? Math.floor(remain / this._speed) : null;
            this._tPrev = tNow;
            this._sentPrev = this._sent;
          }

          this.setDirtyCanvas(true);
        };

        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            try {
              const data = JSON.parse(xhr.responseText || "{}");
              if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
                this._status = "Complete";
                this._savedPath = data.path || "";
              } else {
                this._status = `Error: ${data?.error || xhr.status}`;
              }
            } catch {
              this._status = xhr.status >= 200 && xhr.status < 300 ? "Complete" : `Error: ${xhr.status}`;
            }
            this._xhr = null;
            this.setDirtyCanvas(true);
          }
        };

        xhr.onerror = () => {
          this._status = "Network error";
          this._xhr = null;
          this.setDirtyCanvas(true);
        };

        xhr.open("POST", "/az/upload", true);
        xhr.send(form);
      });

      // Cancel button
      this.addWidget("button", "Cancel", "Stop", () => {
        if (this._xhr) {
          this._xhr.abort();
          this._xhr = null;
          this._status = "Canceled";
          this.setDirtyCanvas(true);
        }
      });

      // draw
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

        // Filename / saved path lines
        if (this._filename) {
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText(`File: ${this._filename}  (${fmtBytes(this._total)})`, pad, yBar - 10);
        }
        if (this._savedPath) {
          ctx.fillStyle = "#9bc27c";
          ctx.fillText(`Saved: ${this._savedPath}`, pad, yBar - 42);
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

      return r;
    };
  },
});
