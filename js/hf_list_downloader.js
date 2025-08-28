// js/hf_list_downloader.js
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

(function injectOnce(){
  if (document.getElementById("hf-list-dl-style")) return;
  const css = document.createElement("style");
  css.id = "hf-list-dl-style";
  css.textContent = `
  .hfld-wrap { display:flex; flex-direction:column; gap:8px; width:100%; }
  .hfld-row { display:grid; grid-template-columns: 22px 1fr max-content; align-items:center;
              padding:6px 8px; border:1px solid #333; border-radius:8px; background:#1f1f1f; }
  .hfld-row div { background: none !important; }
  .hfld-row.downloading { animation: hfldPulse 1.2s ease-in-out infinite alternate; background: rgba(80,140,255,0.15); }
  .hfld-row.done { background: rgba(60,200,120,0.18); border-color:#3dc878; }
  .hfld-row.error { background: rgba(220,80,80,0.18); border-color:#e07070; }
  @keyframes hfldPulse { from{ background: rgba(80,140,255,0.10); } to{ background: rgba(80,140,255,0.25); } }
  .hfld-list { flex: 1; overflow:auto; display:flex; flex-direction:column; gap:6px; }
  .hfld-toolbar { display:flex; gap:6px; flex-wrap:wrap; }
  .hfld-btn, .hfld-input { height:26px; border-radius:6px; border:1px solid #444; background:#2a2a2a; color:#ddd; padding:0 8px; }
  .hfld-btn { cursor:pointer; }
  .hfld-msg { color:#9ab; font-size:12px; min-height:16px; }
  .hfld-time { font-size:11px; color:#cbd; padding-left:10px; white-space:nowrap; }
  `;
  document.head.appendChild(css);
})();

app.registerExtension({
  name: "comfyui.hf_list_downloader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "hf_list_downloader") return;

    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;

      this.properties = this.properties || {};
      this.properties.list_path = this.properties.list_path || "download_list.txt";
      this.serialize_widgets = true;

      const wrap = document.createElement("div");
      wrap.className = "hfld-wrap";

      // Toolbar
      const bar = document.createElement("div");
      bar.className = "hfld-toolbar";

      const pathInput = document.createElement("input");
      pathInput.className = "hfld-input";
      pathInput.placeholder = "Path to download_list.txt";
      pathInput.value = this.properties.list_path;

      const btnRead = document.createElement("button");
      btnRead.className = "hfld-btn";
      btnRead.textContent = "Read";

      const btnRefresh = document.createElement("button");
      btnRefresh.className = "hfld-btn";
      btnRefresh.textContent = "Refresh";

      const btnSelectAll = document.createElement("button");
      btnSelectAll.className = "hfld-btn";
      btnSelectAll.textContent = "Select All";

      const btnClear = document.createElement("button");
      btnClear.className = "hfld-btn";
      btnClear.textContent = "Clear";

      const btnDownload = document.createElement("button");
      btnDownload.className = "hfld-btn";
      btnDownload.textContent = "Download Selected";

      bar.append(pathInput, btnRead, btnRefresh, btnSelectAll, btnClear, btnDownload);

      // List
      const list = document.createElement("div");
      list.className = "hfld-list";

      // Message line
      const msg = document.createElement("div");
      msg.className = "hfld-msg";

      wrap.append(bar, list, msg);

      const widget = this.addDOMWidget("hfld_ui", "HF List Downloader", wrap);
      widget.computeSize = () => [this.size[0] - 20, 440];

      // State
      let items = []; // {id, repo_id, file_in_repo, local_subdir, el, cb, timeEl}
      const setMsg = (t, isErr=false) => { msg.textContent = t || ""; msg.style.color = isErr? "#e88" : "#9ab"; };

      const fmtTime = (ms) => {
        ms = Math.max(0, Math.floor(ms));
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(h)}:${pad(m)}:${pad(ss)}`;
      };

      const render = () => {
        list.innerHTML = "";
        items.forEach(it => {
          const row = document.createElement("div");
          row.className = "hfld-row";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          const lab = document.createElement("div");
          lab.style.userSelect = "text";
          lab.style.fontSize = "12px";
          lab.textContent = `${it.repo_id}, ${it.file_in_repo}, ${it.local_subdir}`;
          const timeEl = document.createElement("div");
          timeEl.className = "hfld-time";
          timeEl.textContent = "";
          row.append(cb, lab, timeEl);
          list.appendChild(row);
          it.el = row; it.cb = cb; it.timeEl = timeEl;
        });
      };

      const readList = async () => {
        const p = (pathInput.value || "").trim();
        this.properties.list_path = p;
        setMsg("Reading list…");
        try {
          // Server will auto-fetch from DOWNLOAD_LIST (env) or default if missing locally
          const resp = await api.fetchApi(`/hf_list/read?path=${encodeURIComponent(p)}`);
          const data = await resp.json();
          if (!resp.ok || !data.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
          items = data.items || [];
          render();
          setMsg(`Loaded ${items.length} item(s) from ${data.file}.`);
        } catch (e) {
          items = [];
          render();
          setMsg(e.message || "Failed to read list.", true);
        }
      };

      const refreshList = async () => {
        const p = (pathInput.value || "").trim() || "download_list.txt";
        setMsg("Refreshing list from internet…");
        btnRefresh.disabled = true;
        try {
          // Force fetch from internet (uses DOWNLOAD_LIST env if present)
          const resp = await api.fetchApi("/hf_list/refresh", {
            method: "POST",
            body: JSON.stringify({ path: p })
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
          setMsg(`Refreshed from ${data.url} → ${data.file}.`);
          await readList(); // re-render with fresh content
        } catch (e) {
          setMsg(e.message || "Refresh failed.", true);
        } finally {
          btnRefresh.disabled = false;
        }
      };

      const selectAll = () => items.forEach(it => it.cb && (it.cb.checked = true));
      const clearSel  = () => items.forEach(it => it.cb && (it.cb.checked = false));

      const downloadOne = async (it) => {
        if (!it?.el) return { ok:false, error:"Bad item" };
        it.el.classList.remove("done","error");
        it.el.classList.add("downloading");
        const t0 = performance.now();
        try {
          const resp = await api.fetchApi("/hf_list/download", {
            method: "POST",
            body: JSON.stringify({
              repo_id: it.repo_id,
              file_in_repo: it.file_in_repo,
              local_subdir: it.local_subdir
            })
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
          const t1 = performance.now();
          it.el.classList.remove("downloading");
          it.el.classList.add("done");
          if (it.timeEl) it.timeEl.textContent = fmtTime(t1 - t0);
          return { ok:true, dst: data.dst, ms: (t1 - t0) };
        } catch (e) {
          const t1 = performance.now();
          it.el.classList.remove("downloading");
          it.el.classList.add("error");
          if (it.timeEl) it.timeEl.textContent = fmtTime(t1 - t0);
          return { ok:false, error: e.message || "Download failed", ms: (t1 - t0) };
        }
      };

      const downloadSelected = async () => {
        const chosen = items.filter(it => it.cb && it.cb.checked);
        if (!chosen.length) { setMsg("Nothing selected."); return; }
        setMsg(`Downloading ${chosen.length} item(s)…`);
        btnDownload.disabled = true;
        btnRead.disabled = true;
        btnRefresh.disabled = true;
        let okCount = 0, errCount = 0;
        const batchStart = performance.now();

        for (const it of chosen) {
          const res = await downloadOne(it);
          if (res.ok) okCount += 1; else errCount += 1;
        }

        const totalMs = performance.now() - batchStart;
        btnDownload.disabled = false;
        btnRead.disabled = false;
        btnRefresh.disabled = false;
        if (errCount) setMsg(`Finished with ${okCount} success, ${errCount} error(s) in ${fmtTime(totalMs)}.`, true);
        else setMsg(`All ${okCount} item(s) downloaded in ${fmtTime(totalMs)}.`);
      };

      // Wire up
      btnRead.addEventListener("click", readList);
      btnRefresh.addEventListener("click", refreshList);
      btnSelectAll.addEventListener("click", selectAll);
      btnClear.addEventListener("click", clearSel);
      btnDownload.addEventListener("click", downloadSelected);

      // Node canvas sizing
      this.size = [580, 500];

      return r;
    };
  },
});
