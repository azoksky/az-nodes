import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function ensureActiveVisible(dropdown, activeIndex) {
  if (activeIndex < 0 || activeIndex >= dropdown.children.length) return;
  const el = dropdown.children[activeIndex];
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

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== "hf_hub_downloader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      // Persisted properties
      this.properties = this.properties || {};
      this.properties.repo_id = this.properties.repo_id || "";
      this.properties.filename = this.properties.filename || "";
      this.properties.dest_dir = this.properties.dest_dir || "";
      this.properties.token = this.properties.token || "";
      this.serialize_widgets = true;

      // Internal state
      this.gid = null;
      this._pollTimer = null;
      this._status = "Ready";
      this._filepath = "";
      this._autoToken = (this.properties.token || "").trim() === "";

      // Repo input
      const repoInput = document.createElement("input");
      repoInput.type = "text";
      repoInput.placeholder = "Repository ID (e.g. runwayml/stable-diffusion-v1-5)";
      repoInput.value = this.properties.repo_id || "";
      Object.assign(repoInput.style, {
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
      const repoWidget = this.addDOMWidget("repo_id", "Repository", repoInput);
      repoWidget.computeSize = () => [this.size[0] - 20, 34];
      repoInput.addEventListener("input", () => {
        this.properties.repo_id = repoInput.value;
      });

      // Filename input
      const fileInput = document.createElement("input");
      fileInput.type = "text";
      fileInput.placeholder = "Filename (e.g. model.safetensors)";
      fileInput.value = this.properties.filename || "";
      Object.assign(fileInput.style, {
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
      const fileWidget = this.addDOMWidget("filename", "Filename", fileInput);
      fileWidget.computeSize = () => [this.size[0] - 20, 34];
      fileInput.addEventListener("input", () => {
        this.properties.filename = fileInput.value;
      });

      // Token input
      const tokenInput = document.createElement("input");
      tokenInput.type = "password";
      tokenInput.placeholder = "HF Token (auto-filled from env if available)";
      tokenInput.value = this.properties.token || "";
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
      const tokenWidget = this.addDOMWidget("token", "Token", tokenInput);
      tokenWidget.computeSize = () => [this.size[0] - 20, 34];
      tokenInput.addEventListener("input", () => {
        this._autoToken = false;
        this.properties.token = tokenInput.value;
      });

      // Token hint
      const hintWidget = this.addWidget("info", "Token Hint", "");

      // Auto-fill token from env on node display
      api.fetchApi("/hf/token")
        .then(function(res){ return res.json(); })
        .then((data) => {
          const tok = data && data.token ? data.token : "";
          if (tok && (this._autoToken || tokenInput.value.trim() === "")) {
            tokenInput.value = tok;
            this.properties.token = tok;
            this._autoToken = true;
          }
        })
        .catch(function(){});
      // Optional hint of last 4 chars
      api.fetchApi("/hf/tokens")
        .then(function(res){ return res.json(); })
        .then((data) => {
          if (data && data.hf) {
            hintWidget.setValue("HF ..." + data.hf);
          }
        })
        .catch(function(){});

      // Destination input with dropdown
      const container = document.createElement("div");
      Object.assign(container.style, { position: "relative", width: "100%" });

      const destInput = document.createElement("input");
      destInput.type = "text";
      destInput.placeholder = "Destination folder (e.g. ./models)";
      destInput.value = this.properties.dest_dir || "";
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

      const placeDropdown = () => {
        const rct = destInput.getBoundingClientRect();
        dropdown.style.left = rct.left + "px";
        dropdown.style.top = (rct.bottom + 2) + "px";
        dropdown.style.width = rct.width + "px";
      };

      container.appendChild(destInput);
      const destWidget = this.addDOMWidget("dest_dir", "Destination", container);
      destWidget.computeSize = () => [this.size[0] - 20, 34];

      let items = [];
      let active = -1;
      let debounceTimer = null;

      const renderDropdown = () => {
        const prevScroll = dropdown.scrollTop;
        dropdown.innerHTML = "";
        if (!items.length) {
          dropdown.style.display = "none";
          active = -1;
          return;
        }
        for (let idx = 0; idx < items.length; idx++) {
          const it = items[idx];
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
        }
        placeDropdown();
        dropdown.style.display = "block";
        dropdown.scrollTop = prevScroll;
        ensureActiveVisible(dropdown, active);
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
            items = data.folders.map(function (f) {
              return { name: f.name, path: ((data.root || val) + "/" + f.name).replace(/\\/g, "/").replace(/\/{2,}/g, "/") };
            });
          } else {
            items = [];
          }
        } catch (e) {
          items = [];
        }
        active = items.length ? 0 : -1;
        renderDropdown();
      };

      const scheduleFetch = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(fetchChildren, 180);
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
        fetchChildren();
      });

      destInput.addEventListener("keydown", (e) => {
        if (dropdown.style.display !== "block" || !items.length) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          active = (active + 1) % items.length;
          renderDropdown();
          ensureActiveVisible(dropdown, active);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          active = (active - 1 + items.length) % items.length;
          renderDropdown();
          ensureActiveVisible(dropdown, active);
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
        setTimeout(function () { dropdown.style.display = "none"; }, 120);
      });

      // Buttons
      this.addWidget("button", "Download", "Start", async () => {
        if (this.gid) return;
        const repo_id = (repoInput.value || "").trim();
        const filename = (fileInput.value || "").trim();
        const dest_dir = (destInput.value || "").trim();
        const token = (tokenInput.value || "").trim();
        if (!repo_id || !filename || !dest_dir) {
          this._status = "Please fill all fields";
          this.setDirtyCanvas(true);
          return;
        }
        this._status = "Starting...";
        this._filepath = "";
        this.setDirtyCanvas(true);

        try {
          const res = await api.fetchApi("/hf/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo_id: repo_id, filename: filename, dest_dir: dest_dir, token_input: token })
          });
          const out = await res.json();
          if (!res.ok || !out.ok) {
            this._status = "Error: " + (out.error || res.status);
            this.setDirtyCanvas(true);
            return;
          }
          this.gid = out.gid;
          this._status = "Running";
          this.setDirtyCanvas(true);

          const poll = async () => {
            if (!this.gid) return;
            try {
              const sRes = await api.fetchApi("/hf/status?gid=" + encodeURIComponent(this.gid));
              const s = await sRes.json();
              if (!s.ok) {
                this._status = "Error: " + (s.error || "Unknown");
                this.gid = null;
                this.setDirtyCanvas(true);
                return;
              }
              this._status = s.msg || s.state || "running";
              this._filepath = s.filepath || "";
              this.setDirtyCanvas(true);
              if (s.state === "done" || s.state === "error" || s.state === "stopped") {
                this.gid = null;
                return;
              }
              this._pollTimer = setTimeout(poll, 800);
            } catch (e) {
              this._pollTimer = setTimeout(poll, 1000);
            }
          };
          poll();
        } catch (e) {
          this._status = "Error starting: " + e.message;
          this.setDirtyCanvas(true);
        }
      });

      this.addWidget("button", "Cancel", "Stop", async () => {
        if (!this.gid) return;
        try {
          await api.fetchApi("/hf/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gid: this.gid })
          });
        } catch (e) {}
      });

      // Canvas draw
      this.size = [480, 220];
      this.onDrawForeground = (ctx) => {
        const pad = 10;
        ctx.font = "12px sans-serif";
        ctx.fillStyle = "#bbb";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const s1 = "Status: " + (this._status || "");
        ctx.fillText(s1, pad, this.size[1] - 44);
        if (this._filepath) {
          ctx.fillStyle = "#8fa3b7";
          ctx.fillText("Saved: " + this._filepath, pad, this.size[1] - 26);
        }
      };

      // Cleanup on removal
      const oldRemoved = this.onRemoved;
      const onScroll = () => { placeDropdown(); };
      const onResize = () => { placeDropdown(); };
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);

      this.onRemoved = function () {
        if (this._pollTimer) clearTimeout(this._pollTimer);
        try { if (dropdown.parentNode) dropdown.parentNode.removeChild(dropdown); } catch (e) {}
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        if (oldRemoved) oldRemoved.apply(this, arguments);
      };

      return r;
    };
  },
});
