from __future__ import annotations
import json, os, socket, subprocess, threading
from pathlib import Path
from urllib.parse import unquote, urlparse
from gi.repository import GObject, Nautilus

MOUNT = Path(os.environ.get("OMARCHY_DRIVE_MOUNT", str(Path.home()/"Proton Drive"))).resolve()
SOCKET = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")
EMBLEMS = {"cloud-only":"emblem-synchronizing", "cached":"emblem-default", "pinned":"emblem-favorite", "downloading":"emblem-synchronizing", "uploading":"emblem-synchronizing", "dirty":"emblem-synchronizing", "queued":"emblem-synchronizing", "conflict":"emblem-important", "error":"emblem-important"}

def rpc(method, **params):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(.25); conn.connect(SOCKET); conn.sendall((json.dumps({"id":1,"method":method,"params":params})+"\n").encode()); data=b""
        while b"\n" not in data: data += conn.recv(65536)
    response=json.loads(data.split(b"\n",1)[0]);
    if "error" in response: raise RuntimeError(response["error"]["message"])
    return response["result"]

def drive_path(info):
    parsed=urlparse(info.get_uri())
    if parsed.scheme != "file": return None
    path=Path(unquote(parsed.path)).resolve()
    try: path.relative_to(MOUNT); return path
    except ValueError: return None

def node_id(path):
    value=os.getxattr(path, "user.omarchy-drive.node-id").decode()
    if not value or "/" in value: raise ValueError("invalid node id")
    return value

class OmarchyDriveExtension(GObject.GObject, Nautilus.MenuProvider, Nautilus.InfoProvider):
    def update_file_info(self, info):
        path=drive_path(info)
        if not path: return
        try:
            state=rpc("GetNodeStatus", nodeId=node_id(path))
            if state:
                info.add_string_attribute("omarchy_drive_status", state["status"])
                emblem=EMBLEMS.get(state["status"])
                if emblem: info.add_emblem(emblem)
        except (OSError, RuntimeError, ValueError): pass
    def get_file_items(self, files):
        selected=[]
        for info in files:
            path=drive_path(info)
            if not path: return []
            try: selected.append(node_id(path))
            except (OSError, ValueError): return []
        root=Nautilus.MenuItem(name="OmarchyDrive::root", label="Proton Drive", tip="Proton Drive file actions")
        menu=Nautilus.Menu(); root.set_submenu(menu)
        def item(key, label, method, **extra):
            action=Nautilus.MenuItem(name=f"OmarchyDrive::{key}", label=label, tip=label)
            action.connect("activate", lambda *_: threading.Thread(target=lambda: [rpc(method, nodeId=n, **extra) for n in selected], daemon=True).start()); menu.append_item(action)
        item("pin", "Always available offline", "SetPinned", pinned=True)
        item("evict", "Free local space", "Evict")
        item("retry", "Retry sync", "Retry")
        return [root]
