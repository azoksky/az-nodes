import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/** Small helper to simplify element creation */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  const { style, dataset, ...rest } = attrs || {};
  Object.assign(n, rest);
  if (style) Object.assign(n.style, style);
  if (dataset) Object.assign(n.dataset, dataset);
  for (const c of children) {
    if (c == null) continue;
    n.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

/** Inject the CSS used by the indeterminate progress bar (only once) */
(function ensureIndeterminateStyle() {
  if (document.getElementById("hf-indeterminate-style")) return;
  const style = document.createElement("style");
  style.id = "hf-indeterminate-style";
  style.textContent = `
@keyframes hfIndeterminate {
  0%   { transform: translateX(-100%); }
  50%  { transform: translateX(0%); }
  100% { transform: translateX(100%); }
}
.hf-indeterminate-track {
  position: relative;
  height: 10px;
  background: rgba(255,255,255,0.12);
  border-radius: 6px;
  overflow: hidden;
}
.hf-indeterminate-bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 34%;
  background: rgba(255,255,255,0.35);
  border-radius: 6px;
  animation: hfIndeterminate 1.2s linear infinite;
}
.hf-status {
  font-size: 12px;
  opacity: 0.85;
}
.hf-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.hf-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.hf-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hf-input {
  width: 100%;
  padding: 6px 8px;
  box-sizing: border-box;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(0,0,0,0.2);
  color: inherit;
}
.hf-btn {
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.15);
  background: rgba(255,255,255,0.06);
  cursor: pointer;
}
.hf-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
`;
  document.head.appendChild(style);
})();

/** Small API helpers (use ComfyUI’s API wrapper for auth/csrf consistency) */
async function postJSON(path, body) {
  const res = await api.fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function getJSON(path) {
  const res = await api.fetchApi(path, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // Keep any previously stored gid across UI refreshes
    node.__hf_gid = node.__hf_gid || null;
    node.__hf_poll = node.__hf_poll || null;

    // ---- UI: container ----
    const root = el("div", {
      className: "hf-col",
      style: { gap: "10px", width: "100%", padding: "10px" },
    });

    // ---- Inputs ----
    const repoInput = el("input", {
      className: "hf-input",
      type: "text",
      placeholder: "Repository ID (e.g. runwayml/stable-diffusion-v1-5)",
      value: node.properties?.repo_id || "",
    });
    const fileInput = el("input", {
      className: "hf-input",
      type: "text",
      placeholder: "Filename inside repo (e.g. model.safetensors)",
      value: node.properties?.filename || "",
    });
    const destInput = el("input", {
      className: "hf-input",
      type: "text",
      placeholder: "Destination folder (e.g. ./models)",
      value: node.properties?.dest_dir || "",
    });

    // Keep node.properties in sync without triggering downloads
    node.properties = node.properties || {};
    const syncProps = () => {
      node.properties.repo_id = repoInput.value ?? "";
      node.properties.filename = fileInput.value ?? "";
      node.properties.dest_dir = destInput.value ?? "";
    };
    [repoInput, fileInput, destInput].forEach((inp) =>
      inp.addEventListener("change", syncProps)
    );

    // ---- Status text ----
    const statusText = el("div", { className: "hf-status" }, "Idle.");

    // ---- Indeterminate progress bar (hidden by default) ----
    const track = el("div", {
      className: "hf-indeterminate-track",
      style: { display: "none" }, // hidden until start
    }, el("div", { className: "hf-indeterminate-bar" }));

    // ---- Actions ----
    const startBtn = el("button", { className: "hf-btn" }, "Download");
    const stopBtn = el("button", { className: "hf-btn", disabled: true }, "Stop");

    // Layout
    root.append(
      el("div", { className: "hf-col" },
        el("label", {}, "Repository ID"),
        repoInput
      ),
      el("div", { className: "hf-col" },
        el("label", {}, "Filename"),
        fileInput
      ),
      el("div", { className: "hf-col" },
        el("label", {}, "Destination Folder"),
        destInput
      ),
      el("div", { className: "hf-actions" }, startBtn, stopBtn),
      statusText,
      track
    );

    // Attach to the node’s DOM
    // ComfyUI nodes expose a `node.addDOMWidget` in many community nodes; if not present,
    // we can append to the node’s `widgets_container` safely.
    const attach = () => {
      // Prefer the built-in widgets container to avoid covering the canvas.
      if (node.widgets && node.widgets.length > 0 && node.widgets[0]?.inputEl) {
        // If a text widget exists, place after it:
        const parent = node.widgets[0].inputEl.closest(".widget")?.parentElement || node.__uiContainer || node;
        parent.appendChild(root);
      } else if (node.__uiContainer) {
        node.__uiContainer.appendChild(root);
      } else if (node.el && node.el.content) {
        node.el.content.appendChild(root);
      } else if (node.el) {
        node.el.appendChild(root);
      } else {
        // Last resort: attach to document (rare).
        document.body.appendChild(root);
      }
    };
    attach();

    // Cleanup on node removal
    const oldOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      try {
        if (node.__hf_poll) {
          clearInterval(node.__hf_poll);
          node.__hf_poll = null;
        }
        root.remove();
      } catch {}
      if (oldOnRemoved) return oldOnRemoved.apply(this, arguments);
    };

    // ---- Behavior helpers (no progress math) ----
    const setBusy = (busy, msg) => {
      startBtn.disabled = !!busy;
      stopBtn.disabled = !busy;
      if (typeof msg === "string") statusText.textContent = msg;
      track.style.display = busy ? "" : "none";
    };
    const setIdle = (msg) => setBusy(false, msg ?? "Idle.");

    const pollStatus = async () => {
      if (!node.__hf_gid) return;
      try {
        const data = await getJSON(`/hf/status?gid=${encodeURIComponent(node.__hf_gid)}`);
        // states: starting/running/done/error/stopped (from Python)
        if (data?.state === "running" || data?.state === "starting") {
          setBusy(true, data?.msg || "Download started…");
        } else if (data?.state === "done") {
          setIdle(data?.msg ? `✅ ${data.msg}` : "✅ File download complete.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        } else if (data?.state === "stopped") {
          setIdle(data?.msg || "Stopped.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        } else if (data?.state === "error") {
          setIdle(data?.msg ? `❌ ${data.msg}` : "❌ Error.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        }
      } catch (e) {
        // If status fails temporarily, keep the bar but don’t crash
        console.warn("HF status error:", e);
      }
    };

    // ---- Start download ----
    startBtn.addEventListener("click", async () => {
      // Keep existing values without changing other functionality
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest_dir = destInput.value.trim();

      if (!repo_id || !filename || !dest_dir) {
        statusText.textContent = "Please fill Repository ID, Filename, and Destination folder.";
        return;
      }

      try {
        setBusy(true, "Download started…");
        const resp = await postJSON("/hf/start", { repo_id, filename, dest_dir, gid: node.__hf_gid || undefined });
        if (resp?.ok) {
          node.__hf_gid = resp.gid;
          // (Re)start polling
          if (node.__hf_poll) clearInterval(node.__hf_poll);
          node.__hf_poll = setInterval(pollStatus, 1200);
        } else {
          setIdle(resp?.error ? `❌ ${resp.error}` : "❌ Failed to start.");
        }
      } catch (e) {
        setIdle(`❌ ${e}`);
      }
    });

    // ---- Stop download (best-effort; mirrors Python behavior) ----
    stopBtn.addEventListener("click", async () => {
      if (!node.__hf_gid) {
        setIdle("Stopped.");
        return;
      }
      try {
        const resp = await postJSON("/hf/stop", { gid: node.__hf_gid });
        // Clear UI regardless of backend’s ability to cancel the thread
        setIdle(resp?.msg || "Stopped.");
        node.__hf_gid = null;
        if (node.__hf_poll) {
          clearInterval(node.__hf_poll);
          node.__hf_poll = null;
        }
      } catch (e) {
        setIdle(`❌ ${e}`);
      }
    });

    // If a gid exists from a previous session, resume polling
    if (node.__hf_gid && !node.__hf_poll) {
      node.__hf_poll = setInterval(pollStatus, 1200);
      setBusy(true, "Resuming…");
      pollStatus();
    } else {
      setIdle("Idle.");
    }
  },
});
