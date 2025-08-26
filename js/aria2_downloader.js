// Loaded via WEB_DIRECTORY from this custom node.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const normalizePath = (p) => (p || "").replace(/\\/g, "/");

function fmtBytes(b){ if(!b||b<=0) return "0 B";
  const u=["B","KB","MB","GB","TB"];
  const i=Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i];
}
function fmtETA(s){ if(s==null) return "—";
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
  if(h) return `${h}h ${m}m ${sec}s`;
  if(m) return `${m}m ${sec}s`;
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
      this.properties.dest_dir = normalizePath(this.properties.dest_dir || "");

      this.addWidget("text", "URL", this.properties.url,
        v => this.properties.url = v ?? "");

      // ===== Destination input with dropdown (same style as PathUploader) =====
      const container = document.createElement("div");
      Object.assign(container.style,{ position:"relative", width:"100%" });

      const destInput = document.createElement("input");
      destInput.type="text";
      destInput.placeholder="Destination folder...";
      Object.assign(destInput.style,{
        width:"100%", height:"26px", padding:"2px 8px",
        border:"1px solid #444", borderRadius:"6px",
        background:"var(--comfy-input-bg, #2a2a2a)", color:"#ddd"
      });
      destInput.value = this.properties.dest_dir;

      const dropdown = document.createElement("div");
      Object.assign(dropdown.style,{
        position:"absolute", top:"100%", left:"0", right:"0",
        background:"#222", border:"1px solid #555", zIndex:"9999",
        display:"none", maxHeight:"180px", overflowY:"auto",
        fontSize:"12px", borderRadius:"6px"
      });

      container.appendChild(destInput);
      container.appendChild(dropdown);

      const destWidget = this.addDOMWidget("dest_dir","Destination",container);
      destWidget.computeSize = () => [this.size[0]-20, 34];

      let items=[], active=-1, debounce=null;
      const render=()=>{
        dropdown.innerHTML="";
        if(!items.length){ dropdown.style.display="none"; active=-1; return; }
        items.forEach((it,idx)=>{
          const row=document.createElement("div");
          row.textContent=it.name;
          Object.assign(row.style,{
            padding:"5px 8px", cursor:"pointer", whiteSpace:"nowrap",
            background: idx===active? "#444":"transparent"
          });
          row.onmouseenter=()=>{ active=idx; render(); };
          const choose=()=>{
            const chosen=normalizePath(it.path);
            destInput.value=chosen;
            this.properties.dest_dir=chosen;
            dropdown.style.display="none"; items=[]; active=-1;
          };
          row.addEventListener("pointerdown",(e)=>{e.preventDefault(); choose();});
          dropdown.appendChild(row);
        });
        dropdown.style.display="block";
      };

      const fetchChildren=async()=>{
        const raw=destInput.value.trim();
        if(!raw){ items=[]; render(); return; }
        try{
          const resp=await api.fetchApi(`/aria2/suggest?prefix=${encodeURIComponent(raw)}`);
          const data=await resp.json();
          if(data?.ok){
            items=data.folders.map(f=>({name:f.name,path:f.path}));
            active=items.length?0:-1;
            render();
          }else{ items=[]; render(); }
        }catch{ items=[]; render(); }
      };

      destInput.addEventListener("input",()=>{
        destInput.value=normalizePath(destInput.value);
        this.properties.dest_dir=destInput.value;
        clearTimeout(debounce);
        debounce=setTimeout(fetchChildren,200);
      });

      destInput.addEventListener("focus",()=>{ fetchChildren(); });
      destInput.addEventListener("keydown",(e)=>{
        if(dropdown.style.display!=="block"||!items.length)return;
        if(e.key==="ArrowDown"){ e.preventDefault(); active=(active+1)%items.length; render(); }
        else if(e.key==="ArrowUp"){ e.preventDefault(); active=(active-1+items.length)%items.length; render(); }
        else if(e.key==="Enter"){ if(active>=0){ e.preventDefault(); const it=items[active]; destInput.value=normalizePath(it.path); this.properties.dest_dir=destInput.value; dropdown.style.display="none"; items=[]; active=-1; } }
        else if(e.key==="Escape"){ dropdown.style.display="none"; items=[]; active=-1; }
      });
      destInput.addEventListener("blur",()=>{ setTimeout(()=>{ dropdown.style.display="none"; },120); });

      // ====== state vars and download logic (unchanged) ======
      this.gid=null;
      this._status="Idle";
      this._progress=0;
      this._speed=0;
      this._eta=null;
      this._pollTimer=null;
      this._filename="";
      this._filepath="";

      // (rest of your download button + drawing logic remains unchanged)

      return r;
    };
  }
});
