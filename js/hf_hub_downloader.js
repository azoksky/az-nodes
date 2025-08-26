import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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

    // Persist across refreshes
    node.__hf_gid = node.__hf_gid || null;
    node.__hf_poll = node.__hf_poll || null;
    node.__hf_running = node.__hf_running || false;

    // -------- Widgets (built-in) --------
    node.properties = node.properties || {};
    const repoW = node.addWidget(
      "text",
      "Repository ID",
      node.properties.repo_id ?? "",
      (v) => (node.properties.repo_id = v ?? "")
    );
    const fileW = node.addWidget(
      "text",
      "Filename",
      node.properties.filename ?? "",
      (v) => (node.properties.filename = v ?? "")
    );
    const destW = node.addWidget(
      "text",
      "Destination folder",
      node.properties.dest_dir ?? "",
      (v) => (node.properties.dest_dir = v ?? "")
    );

    const statusW = node.addWidget(
      "text",
      "Status",
      "Idle.",
      null,
      { disabled: true }
    );

    const startBtn = node.addWidget("button", "Download", "start", async () => {
      const repo_id = repoW.value?.trim();
      const filename = fileW.value?.trim();
      const dest_dir = destW.value?.trim();
      if (!repo_id || !filename || !dest_dir) {
        statusW.value = "Please fill Repository ID, Filename, and Destination.";
        node.graph.setDirtyCanvas(true, true);
        return;
      }
      try {
        setRunning(true, "Download started…");
        const resp = await postJSON("/hf/start", {
          repo_id,
          filename,
          dest_dir,
          gid: node.__hf_gid || undefined,
        });
        if (resp?.ok) {
          node.__hf_gid = resp.gid;
          if (node.__hf_poll) clearInterval(node.__hf_poll);
          node.__hf_poll = setInterval(pollStatus, 1200);
        } else {
          setRunning(false, resp?.error ? `❌ ${resp.error}` : "❌ Failed to start.");
        }
      } catch (e) {
        setRunning(false, `❌ ${e}`);
      }
    });

    const stopBtn = node.addWidget("button", "Stop", "stop", async () => {
      if (!node.__hf_gid) {
        setRunning(false, "Stopped.");
        return;
      }
      try {
        const resp = await postJSON("/hf/stop", { gid: node.__hf_gid });
        setRunning(false, resp?.msg || "Stopped.");
        node.__hf_gid = null;
        if (node.__hf_poll) {
          clearInterval(node.__hf_poll);
          node.__hf_poll = null;
        }
      } catch (e) {
        setRunning(false, `❌ ${e}`);
      }
    });

    // -------- Indeterminate progress bar (canvas-drawn) --------
    // A lightweight, always-visible implementation that doesn’t rely on external DOM.
    let animStart = performance.now();
    const barHeight = 12;     // px
    const barWidthFrac = 0.35; // 35% of available width
    const speedPxPerSec = 240; // speed of the sweep

    function drawIndeterminate(ctx, x, y, w) {
      // Track
      const h = barHeight;
      const radius = 4;
      ctx.save();
      ctx.translate(x, y);
      // Track background
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      roundRect(ctx, 0, 0, w, h, radius);
      ctx.fill();

      // Moving bar
      const elapsed = (performance.now() - animStart) / 1000;
      const barWidth = Math.max(24, w * barWidthFrac);
      const travel = w + barWidth;
      const offset = (elapsed * speedPxPerSec) % travel - barWidth;
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      roundRect(ctx, offset, 0, barWidth, h, radius);
      ctx.fill();
      ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, h / 2, w / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }

    // Custom widget to reserve space for the bar and draw it when running
    const barWidget = node.addWidget("custom", "Progress", null, () => {}, {
      get value() { return null; },
      set value(_) {},
      // Reserve vertical space
      computeSize: () => [node.size[0], barHeight + 8],
      draw: (ctx, node_, width, y) => {
        if (!node.__hf_running) return;
        // Draw centered inside this widget area
        const padX = 10;
        const w = Math.max(40, width - padX * 2);
        const x = padX;
        const top = y + 4;
        drawIndeterminate(ctx, x, top, w);
        // Trigger re-draw for animation
        node_.graph.setDirtyCanvas(true);
      },
    });

    // -------- Helpers --------
    function setRunning(on, msg) {
      node.__hf_running = !!on;
      statusW.value = msg || (on ? "Working…" : "Idle.");
      startBtn.disabled = !!on;
      stopBtn.disabled = !on;
      if (!on) animStart = performance.now(); // reset phase next time
      node.graph.setDirtyCanvas(true, true);
    }

    async function pollStatus() {
      if (!node.__hf_gid) return;
      try {
        const data = await getJSON(`/hf/status?gid=${encodeURIComponent(node.__hf_gid)}`);
        if (data?.state === "running" || data?.state === "starting") {
          setRunning(true, data?.msg || "Download started…");
        } else if (data?.state === "done") {
          setRunning(false, data?.msg ? `✅ ${data.msg}` : "✅ File download complete.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        } else if (data?.state === "stopped") {
          setRunning(false, data?.msg || "Stopped.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        } else if (data?.state === "error") {
          setRunning(false, data?.msg ? `❌ ${data.msg}` : "❌ Error.");
          node.__hf_gid = null;
          if (node.__hf_poll) {
            clearInterval(node.__hf_poll);
            node.__hf_poll = null;
          }
        }
      } catch (e) {
        // keep animating; transient errors are fine
        console.warn("HF status error:", e);
      }
    }

    // Clean up when node is removed
    const oldOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      try {
        if (node.__hf_poll) {
          clearInterval(node.__hf_poll);
          node.__hf_poll = null;
        }
      } catch {}
      if (oldOnRemoved) return oldOnRemoved.apply(this, arguments);
    };

    // Resume if a job was in-flight
    if (node.__hf_gid && !node.__hf_poll) {
      node.__hf_poll = setInterval(pollStatus, 1200);
      setRunning(true, "Resuming…");
      pollStatus();
    } else {
      setRunning(false, "Idle.");
    }
  },
});
