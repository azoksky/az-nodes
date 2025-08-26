// Path Uploader UI: destination path with dropdown (type-ahead), validations,
// upload progress (speed + ETA), cancel button.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0) + " " + u[i];
}
function fmtETA(s) {
  if (s == null) return "—";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function joinPath(base, seg, sep) {
  if (!base) return seg;
  if (!seg) return base;
  const trailing = base.endsWith("\\") || base.endsWith("/");
  return trailing ? base + seg : base + (sep || "/") + seg;
}

app.registerExtension({
  name: "az.path.uploader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "PathUploader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      // ---- persistent model ----
      this.properties = this.properties || {};
      this.properties.dest_dir = this.properties.dest_dir || "";

      // ---- transient state ----
      this._status = "Idle";
      this._progress = 0;
      this._speed = 0;
      this._eta = null;
      this._sent = 0;
      this._total = 0;
      this._savedPath = "";
      this._filename = "";
      this._xhr = null;
      this._selectedFile = null;
      this._tPrev = 0;
      this._sentPrev = 0;

      // ---- DESTINATION: input + dropdown list ----
      const destInput = document.createElement("input");
      destInput.type = "text";
      destInput.placeholder = "Destination Folder (e.g., C:/Users/you/Downloads or ~/models)";
      destInput.style.width = "100%";

      const list = document.createElement("datalist");
      const listId = "az-dir-list-" + Math.floor(Math.random() * 1e9);
      list.id = listId;
      destInput.setAttribute("list", listId);

      // seed with existing value
      destInput.value = this.properties.dest_dir || "";

      // debounce fetch
      let listdirTimer = null;
      const scheduleListdir = () => {
        if (listdirTimer) clearTimeout(listdirTimer);
        listdirTimer = setTimeout(fetchChildren, 200);
      };

      const fetchChildren = async () => {
        const val = destInput.value.trim();
        if (!val) { list.innerHTML = ""; return; }
        try {
          const resp = await api.fetchApi(`/az/listdir?path=${encodeURIComponent(val)}`);
          const data = await resp.json();
          list.innerHTML = "";
          if (data?.ok && data.folders?.length) {
            const sep = data.sep || "/";
            for (const folder of data.folders) {
              const full = joinPath(data.root || val, folder.name, sep);
              const opt = document.createElement("option");
              opt.value = full;
              opt.label = folder.name;
              list.appendChild(opt);
            }
          }
        } catch (e) {
          // silent fail; keep prior list
          console.warn("listdir failed", e);
        }
      };

      destInput.addEventListener("input", () => {
        this.properties.dest_dir = destInput.value;
        scheduleListdir();
      });
      destInput.addEventListener("change", () => {
        this.properties.dest_dir = destInput.value;
        scheduleListdir();
      });

      const destWidget = this.addDOMWidget("dest_dir", "Destination Folder", destInput);
      destWidget.inputEl = destInput;
      destInput.after(list);

      // ---- FILE PICKER ----
      this.addWidget("button", "Choose File", "Browse…", () => {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.onchange = () => {
          if (!picker.files || !picker.files[0]) return;
          const f = picker.files[0];
          this._selectedFile = f;
          this._filename = f.name;
          this._total = f.size;
          this._sent = 0;
          this._progress = 0;
          this._status = "Ready";
          this._savedPath = "";
          this.setDirtyCanvas(true);
        };
        picker.click();
      });

      // ---- UPLOAD ----
      this.addWidget("button", "Upload", "Start", async () => {
        // validations
        if (!this._selectedFile) {
          this._status = "Please select a file first.";
          this.setDirtyCanvas(true);
          return;
        }
        const dest = (this.properties.dest_dir || "").trim();
        if (!dest) {
          this._status = "Please enter destination folder.";
          this.setDirtyCanvas(true);
          return;
        }
        if (this._xhr) return; // already uploading

        const form = new FormData();
        form.append("file", this._selectedFile, this._selectedFile.name);
        form.append("dest_dir", dest);

        const xhr = new XMLHttpRequest();
        this._xhr = xhr;
        this._status = "Uploading…";
        this._progress = 0;
        this._sent = 0;
        this._savedPath = "";
        this._speed = 0;
        this._eta = null;
        this._tPrev = performance.now();
        this._sentPrev = 0;
        this.setDirtyCanvas(true);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            this._sent = e.loaded;
            this._total = e.total;
            this._progress = Math.max(0, Math.min(100, (e.loaded / e.total) * 100));
          } else {
            // fallback update
            this._sent = e.loaded || this._sent;
            this._progress = this._total ? (this._sent / this._total) * 100 : this._progress;
          }
          const tNow = performance.now();
          const dt = (tNow - this._tPrev) / 1000;
          if (dt > 0.25) {
            const dBytes = this._sent - this._sentPrev;
            this._speed = dBytes / dt;
            const remain = Math.max(this._total - this._sent, 0);
            this._eta = this._speed > 0 ? Math.floor(remain / this._speed) : null;
            this._tPrev = tNow;
            this._sentPrev = this._sent;
          }
          this.setDirtyCanvas(true);
        };

        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            let data = null;
            try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
            if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
              this._status = "Complete";
              this._savedPath = data.path || "";
              this._progress = 100;
            } else {
              const err = (data && (data.error || data.message)) || `HTTP ${xhr.status}`;
              this._status = `Error: ${err}`;
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

      // ---- CANCEL ----
      this.addWidget("button", "Cancel", "Stop", () => {
        if (this._xhr) {
          this._xhr.abort();
          this._xhr = null;
          this._status = "Canceled";
          this.setDirtyCanvas(true);
        }
      });

      // ---- draw ----
      this.size = [500, 210];
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
        ctx.fillText(meta, pad, yBar - 28);

        // File name + size
        if (this._filename) {
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText(`File: ${this._filename} (${fmtBytes(this._total)})`, pad, yBar - 12);
        }

        // Saved path (when known)
        if (this._savedPath) {
          ctx.fillStyle = "#9bc27c";
          ctx.fillText(`Saved: ${this._savedPath}`, pad, yBar - 44);
        }

        // Progress outline
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

      // Kick initial suggestions if a value was prefilled
      if (destInput.value) {
        setTimeout(() => {
          destInput.dispatchEvent(new Event("input"));
        }, 50);
      }

      return r;
    };
  },
});
