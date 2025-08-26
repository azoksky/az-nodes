import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

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
      this.properties = this.properties || {};
      this.properties.dest_dir = this.properties.dest_dir || "";

      // ---- custom input with dropdown ----
      const container = document.createElement("div");
      Object.assign(container.style, { position: "relative", width: "100%" });

      const destInput = document.createElement("input");
      destInput.type = "text";
      destInput.placeholder = "Destination folder";
      Object.assign(destInput.style, {
        width: "100%", height: "26px", padding: "2px 8px",
        border: "1px solid #444", borderRadius: "6px",
        background: "var(--comfy-input-bg, #2a2a2a)", color: "#ddd",
        boxSizing: "border-box"
      });
      destInput.value = this.properties.dest_dir || "";

      const dropdown = document.createElement("div");
      Object.assign(dropdown.style, {
        position: "absolute",
        top: "100%",
        left: "0",
        right: "0",
        background: "#222",
        border: "1px solid #555",
        zIndex: "9999",
        display: "none",
        maxHeight: "150px",
        overflowY: "auto",
        fontSize: "12px"
      });

      container.appendChild(destInput);
      container.appendChild(dropdown);
      const widget = this.addDOMWidget("dest_dir", "Destination", container);
      widget.computeSize = () => [this.size[0]-20, 34];

      const showDropdown = (items) => {
        dropdown.innerHTML = "";
        if (!items || !items.length) { dropdown.style.display = "none"; return; }
        items.forEach(it => {
          const div = document.createElement("div");
          div.textContent = it.name;
          Object.assign(div.style, {
            padding: "4px 8px", cursor: "pointer", whiteSpace: "nowrap"
          });
          div.onmouseenter = () => div.style.background = "#444";
          div.onmouseleave = () => div.style.background = "transparent";
          div.onclick = () => {
            destInput.value = it.path;
            this.properties.dest_dir = it.path;
            dropdown.style.display = "none";
          };
          dropdown.appendChild(div);
        });
        dropdown.style.display = "block";
      };

      let timer = null;
      const fetchList = async () => {
        const val = destInput.value.trim();
        if (!val) { dropdown.style.display = "none"; return; }
        try {
          const resp = await api.fetchApi(`/az/listdir?path=${encodeURIComponent(val)}`);
          const data = await resp.json();
          if (data?.ok && data.folders) {
            showDropdown(data.folders.map(f => ({
              name: f.name,
              path: joinPath(data.root, f.name, data.sep)
            })));
          } else {
            dropdown.style.display = "none";
          }
        } catch {
          dropdown.style.display = "none";
        }
      };

      destInput.addEventListener("input", () => {
        this.properties.dest_dir = destInput.value;
        if (timer) clearTimeout(timer);
        timer = setTimeout(fetchList, 200);
      });

      destInput.addEventListener("blur", () => {
        setTimeout(() => { dropdown.style.display = "none"; }, 150);
      });

      // rest of your widgets (Choose File, Upload, Cancel) stay as before…
      // keep your progress drawing logic unchanged.

      return r;
    };
  },
});
