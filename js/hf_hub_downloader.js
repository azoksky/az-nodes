import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/** ---------- small helpers ---------- */
function fmtBytes(b) {
  if (!b || b <= 0) return "0 B";
  const u = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i];
}

function fmtETA(s) {
  if (s == null || s <= 0) return "—";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function normalizePath(p){
  return (p||"").replaceAll("\\\\","/");
}

/**
 * Minimal DOM factory helpers
 */
function el(tag, attrs={}, ...children){
  const n = document.createElement(tag);
  const { style, ...rest } = attrs || {};
  if (rest) Object.assign(n, rest);
  if (style && typeof style === "object") Object.assign(n.style, style);
  for (const c of children) n.append(c);
  return n;
}

/**
 * Register a UI-only node
 */
app.registerExtension({
  name: "aznodes.hf_hub_downloader",
  async nodeCreated(node) {
    if (node.comfyClass !== "hf_hub_downloader") return;

    // --- panel ---
    const wrap = el("div",{style:{display:"flex",flexDirection:"column",gap:"8px",width:"100%"}});

    // repo_id
    const repoInput = el("input",{
      type:"text",
      placeholder:"repo_id (e.g. mit-han-lab/nunchaku-flux.1-dev)",
      style:{width:"100%"}
    });

    // filename
    const fileInput = el("input",{
      type:"text",
      placeholder:"filename (e.g. svdq-int4_r32-flux.1-dev.safetensors)",
      style:{width:"100%"}
    });

    // destination input with dropdown chooser
    const destRow = el("div",{style:{display:"flex",gap:"6px",alignItems:"center"}});
    const destInput = el("input",{type:"text",placeholder:"Destination folder",style:{flex:"1"}});
    const browseBtn = el("button",{textContent:"Browse"});
    destRow.append(destInput,browseBtn);

    // dropdown implementation with better cleanup
    const dropdown = el("div",{style:{
      position:"absolute",
      zIndex:1000,
      display:"none",
      maxHeight:"240px",
      overflow:"auto",
      background:"#333",
      border:"1px solid #555",
      borderRadius:"8px"
    }});
    document.body.appendChild(dropdown);

    let ddItems=[], ddActive=-1;
    let dropdownTimeout = null;
    
    function hideDropdown() {
      dropdown.style.display = "none";
      ddItems = [];
      ddActive = -1;
      if (dropdownTimeout) {
        clearTimeout(dropdownTimeout);
        dropdownTimeout = null;
      }
    }
    
    function renderDropdown(){
      dropdown.innerHTML="";
      if(!ddItems.length){ 
        hideDropdown();
        return; 
      }
      
      ddItems.forEach((it,idx)=>{
        const row = el("div",{
          textContent:it.path,
          style:{
            padding:"6px 10px",
            cursor:"pointer",
            whiteSpace:"nowrap",
            background: idx===ddActive?"#444":"transparent",
            userSelect:"none"
          }
        });
        row.onmouseenter=()=>{ddActive=idx; renderDropdown();};
        row.onclick=()=>{ 
          destInput.value = normalizePath(it.path); 
          hideDropdown();
        };
        dropdown.append(row);
      });
      
      const r = destInput.getBoundingClientRect();
      Object.assign(dropdown.style,{
        left:`${r.left}px`,
        top:`${r.bottom+2}px`,
        minWidth:`${r.width}px`,
        display:"block"
      });
    }

    // Add debounced input handling to prevent excessive API calls
    let inputTimeout = null;
    destInput.addEventListener("input", () => {
      if (inputTimeout) {
        clearTimeout(inputTimeout);
      }
      
      inputTimeout = setTimeout(async () => {
        try {
          const q = destInput.value.trim();
          if (!q) {
            hideDropdown();
            return;
          }
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
          
          const resp = await api.fetchApi(`/path_uploader/list?q=${encodeURIComponent(q)}`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          if (!resp.ok) {
            hideDropdown();
            return;
          }
          
          const data = await resp.json();
          ddItems = (data.items||[]).slice(0,50);
          ddActive = ddItems.length ? 0 : -1; 
          renderDropdown();
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.warn('Path lookup failed:', e);
          }
          hideDropdown();
        } finally {
          inputTimeout = null;
        }
      }, 300); // 300ms debounce
    });

    destInput.addEventListener("keydown", (e)=>{
      if(dropdown.style.display!=="block") return;
      
      if(e.key==="ArrowDown"){
        ddActive=Math.min(ddActive+1,ddItems.length-1);
        renderDropdown(); 
        e.preventDefault();
      }
      else if(e.key==="ArrowUp"){
        ddActive=Math.max(ddActive-1,0);
        renderDropdown();
        e.preventDefault();
      }
      else if(e.key==="Enter" && ddActive>=0){ 
        destInput.value=normalizePath(ddItems[ddActive].path); 
        hideDropdown();
        e.preventDefault(); 
      }
      else if(e.key==="Escape"){ 
        hideDropdown();
      }
    });

    // Hide dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (!destInput.contains(e.target) && !dropdown.contains(e.target)) {
        hideDropdown();
      }
    });

    // progress bar + status text
    const barWrap = el("div",{style:{height:"10px",background:"#222",border:"1px solid #444",borderRadius:"6px",overflow:"hidden"}});
    const bar = el("div",{style:{height:"100%",width:"0%",background:"#64b5f6",transition:"width 0.3s ease"}});
    barWrap.append(bar);
    const status = el("div",{style:{fontSize:"12px",opacity:0.9,minHeight:"16px"}});

    const btnRow = el("div",{style:{display:"flex",gap:"8px",alignItems:"center"}});
    const dlBtn = el("button",{textContent:"Download"});
    const stopBtn = el("button",{textContent:"Stop",disabled:true});
    btnRow.append(dlBtn,stopBtn);

    wrap.append(repoInput,fileInput,destRow,barWrap,status,btnRow);
    
    node.addDOMWidget((container) => {
      container.appendChild(wrap); 
      return () => { 
        try { 
          hideDropdown();
          dropdown.remove(); 
          if (inputTimeout) clearTimeout(inputTimeout);
          if (dropdownTimeout) clearTimeout(dropdownTimeout);
        } catch {} 
      }
    });

    // state
    node.gid = null;
    let pollTimer = null;
    let pollCount = 0;
    const MAX_POLL_COUNT = 1000; // Prevent infinite polling

    function stopPolling() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      pollCount = 0;
      stopBtn.disabled = true;
      dlBtn.disabled = false;
    }

    async function startPoll(){
      if (!node.gid) return;
      pollCount = 0;
      
      const poll = async () => {
        if (!node.gid || pollCount >= MAX_POLL_COUNT) {
          stopPolling();
          return;
        }
        
        pollCount++;
        
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
          
          const r = await api.fetchApi(`/hf/status?gid=${encodeURIComponent(node.gid)}`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          if (!r.ok) {
            throw new Error(`Status check failed: ${r.status}`);
          }
          
          const s = await r.json();
          
          if (s.error) { 
            status.textContent = `Error: ${s.error}`;
            stopPolling();
            return;
          }
          
          const pct = Math.max(0, Math.min(100, s.percent||0));
          bar.style.width = pct+"%";
          
          const spd = s.downloadSpeed ? `${fmtBytes(s.downloadSpeed)}/s` : "";
          const sizeText = `${fmtBytes(s.completedLength||0)}`;
          const totalText = s.totalLength ? ` / ${fmtBytes(s.totalLength)}` : "";
          const etaText = s.eta ? ` • ETA ${fmtETA(s.eta)}` : "";
          
          status.textContent = `${pct.toFixed(1)}% • ${sizeText}${totalText}${spd ? ` • ${spd}` : ""}${etaText}`;
          
          if (s.status === "complete") {
            status.textContent = `✓ Complete: ${s.filename}`;
            stopPolling();
          } else if (s.status === "error" || s.status === "stopped") {
            stopPolling();
          } else {
            // Continue polling with exponential backoff for failed requests
            const delay = Math.min(1000, 500 + (pollCount > 10 ? pollCount * 100 : 0));
            pollTimer = setTimeout(poll, delay);
          }
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.warn('Status polling failed:', e);
            // Exponential backoff on errors
            const delay = Math.min(5000, 1000 + (pollCount * 200));
            pollTimer = setTimeout(poll, delay);
          } else {
            stopPolling();
          }
        }
      };
      
      poll();
    }

    dlBtn.onclick = async () => {
      const repo_id = repoInput.value.trim();
      const filename = fileInput.value.trim();
      const dest = normalizePath(destInput.value.trim());
      
      if (!repo_id || !filename || !dest) {
        status.textContent = "Please fill repo_id, filename and destination.";
        return;
      }
      
      dlBtn.disabled = true;
      status.textContent = "Starting download...";
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for start
        
        const resp = await api.fetchApi("/hf/start", {
          method:"POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ repo_id, filename, dest_dir: dest }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!resp.ok) {
          throw new Error(`Request failed: ${resp.status}`);
        }
        
        const data = await resp.json();
        if (data.error) { 
          status.textContent = data.error;
          dlBtn.disabled = false;
          return; 
        }
        
        node.gid = data.gid; 
        bar.style.width = "0%"; 
        status.textContent = "Initializing...";
        stopBtn.disabled = false;
        
        startPoll();
      } catch (e) {
        if (e.name !== 'AbortError') {
          status.textContent = "Failed to start: " + e.message;
        } else {
          status.textContent = "Start request timed out";
        }
        dlBtn.disabled = false;
      }
    };

    stopBtn.onclick = async () => {
      if (!node.gid) return;
      
      stopBtn.disabled = true;
      status.textContent = "Stopping...";
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        await api.fetchApi("/hf/stop", {
          method:"POST",
          headers: {"Content-Type": "application/json"},
          body:JSON.stringify({gid:node.gid}),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        stopPolling();
        node.gid = null;
        status.textContent = "Stopped";
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('Stop request failed:', e);
        }
        stopPolling();
      }
    };

    // Cleanup on node removal
    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function() {
      stopPolling();
      hideDropdown();
      if (node.gid) {
        // Try to stop download if node is removed
        api.fetchApi("/hf/stop", {
          method:"POST",
          headers: {"Content-Type": "application/json"},
          body:JSON.stringify({gid:node.gid})
        }).catch(() => {});
      }
      if (originalOnRemoved) {
        originalOnRemoved.call(this);
      }
    };
  }
});
