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
  if (s == null) return "—";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function normalizePath(p){return (p||"").replaceAll("\\\\","/");}

/**
 * Minimal DOM factory helpers so we keep DOM widgets (not subgraph widgets)
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

    // destination input (kept from prior version, with dropdown chooser)
    const destRow = el("div",{style:{display:"flex",gap:"6px",alignItems:"center"}});
    const destInput = el("input",{type:"text",placeholder:"Destination folder",style:{flex:"1"}});
    const browseBtn = el("button",{textContent:"Browse"});
    destRow.append(destInput,browseBtn);

    // simple dropdown implementation copied from earlier approach
    const dropdown = el("div",{style:{position:"absolute",zIndex:1000,display:"none",maxHeight:"240px",overflow:"auto",background:"#333",border:"1px solid #555",borderRadius:"8px"}});
    document.body.appendChild(dropdown);

    let ddItems=[], ddActive=-1;
    function renderDropdown(){
      dropdown.innerHTML="";
      if(!ddItems.length){ dropdown.style.display="none"; return; }
      ddItems.forEach((it,idx)=>{
        const row = el("div",{textContent:it.path,style:{padding:"6px 10px",cursor:"pointer",whiteSpace:"nowrap",background: idx===ddActive?"#444":"transparent",userSelect:"none"}});
        row.onmouseenter=()=>{ddActive=idx; renderDropdown();};
        row.onclick=()=>{ destInput.value = normalizePath(it.path); dropdown.style.display="none"; ddItems=[]; ddActive=-1; };
        dropdown.append(row);
      });
      const r = destInput.getBoundingClientRect();
      Object.assign(dropdown.style,{left:`${r.left}px`,top:`${r.bottom+2}px`,minWidth:`${r.width}px`,display:"block"});
    }

    destInput.addEventListener("input", async () => {
      try {
        const q = destInput.value.trim();
        const resp = await api.fetchApi(`/path_uploader/list?q=${encodeURIComponent(q)}`);
        const data = await resp.json();
        ddItems = (data.items||[]).slice(0,50);
        ddActive = ddItems.length?0:-1; renderDropdown();
      } catch {}
    });
    destInput.addEventListener("keydown", (e)=>{
      if(dropdown.style.display!=="block") return;
      if(e.key==="ArrowDown"){ddActive=Math.min(ddActive+1,ddItems.length-1);renderDropdown(); e.preventDefault();}
      else if(e.key==="ArrowUp"){ddActive=Math.max(ddActive-1,0);renderDropdown();e.preventDefault();}
      else if(e.key==="Enter" && ddActive>=0){ destInput.value=normalizePath(ddItems[ddActive].path); dropdown.style.display="none"; ddItems=[]; e.preventDefault(); }
      else if(e.key==="Escape"){ dropdown.style.display="none"; ddItems=[]; }
    });

    // progress bar + status text
    const barWrap = el("div",{style:{height:"10px",background:"#222",border:"1px solid #444",borderRadius:"6px",overflow:"hidden"}});
    const bar = el("div",{style:{height:"100%",width:"0%",background:"#64b5f6"}});
    barWrap.append(bar);
    const status = el("div",{style:{fontSize:"12px",opacity:0.9}});

    const btnRow = el("div",{style:{display:"flex",gap:"8px",alignItems:"center"}});
    const dlBtn = el("button",{textContent:"Download"});
    const stopBtn = el("button",{textContent:"Stop"});
    btnRow.append(dlBtn,stopBtn);

    wrap.append(repoInput,fileInput,destRow,barWrap,status,btnRow);
    node.addDOMWidget((container) => {container.appendChild(wrap); return () => { try { dropdown.remove(); } catch {} }});

    // state
    node.gid = null;
    let pollTimer=null;

    async function startPoll(){
      if(!node.gid) return;
      const poll = async () => {
        if(!node.gid) return;
        try {
          const r = await api.fetchApi(`/hf/status?gid=${encodeURIComponent(node.gid)}`);
          const s = await r.json();
          if (s.error) { status.textContent = `Error: ${s.error}`; }
          const pct = Math.max(0, Math.min(100, s.percent||0));
          bar.style.width = pct+"%";
          const spd = s.downloadSpeed ? `${fmtBytes(s.downloadSpeed)}/s` : "";
          status.textContent = `${pct.toFixed(2)}% • ${fmtBytes(s.completedLength||0)} / ${fmtBytes(s.totalLength||0)} • ${spd} • ETA ${fmtETA(s.eta)}`;
          if (s.status === "complete" || s.status === "error" || s.status === "stopped") {
            node.gid = null; pollTimer && clearTimeout(pollTimer); pollTimer = null;
          } else {
            pollTimer = setTimeout(poll, 700);
          }
        } catch {
          pollTimer = setTimeout(poll, 900);
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
      try {
        const resp = await api.fetchApi("/hf/start", {
          method:"POST",
          body: JSON.stringify({ repo_id, filename, dest_dir: dest })
        });
        const data = await resp.json();
        if (data.error) { status.textContent = data.error; return; }
        node.gid = data.gid; bar.style.width = "0%"; status.textContent = "Starting...";
        startPoll();
      } catch (e) {
        status.textContent = "Failed to start: "+e;
      }
    };

    stopBtn.onclick = async () => {
      if(!node.gid) return;
      try{
        await api.fetchApi("/hf/stop",{method:"POST",body:JSON.stringify({gid:node.gid})});
      }catch{}
    };
  }
});
