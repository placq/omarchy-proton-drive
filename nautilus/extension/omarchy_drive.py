from __future__ import annotations
import hashlib, json, os, socket, stat, sys, threading
from pathlib import Path
import gi
gi.require_version("GnomeDesktop", "4.0")
gi.require_version("Nautilus", "4.1")
from gi.repository import GnomeDesktop, GObject, Nautilus
from drive_logic import ThumbnailWorkCache, drive_path, node_id, node_status, thumbnail_relevant

MOUNT = Path(os.environ.get("OMARCHY_DRIVE_MOUNT", str(Path.home()/".local/share/omarchy-drive/mount"))).resolve()
SOCKET = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")
EMBLEMS = {"cached":"emblem-default", "pinned":"emblem-favorite", "downloading":"emblem-synchronizing", "uploading":"emblem-synchronizing", "dirty":"emblem-synchronizing", "queued":"emblem-synchronizing", "conflict":"emblem-important", "error":"emblem-important"}
THUMBNAILS = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.NORMAL)
THUMBNAIL_WORK = ThumbnailWorkCache()
LANGUAGE = (os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG") or "en").lower()

def l10n(polish, english):
    return polish if LANGUAGE.startswith("pl") else english

def warn(context, error):
    print(f"omarchy-drive: {context}: {error}", file=sys.stderr)

def suppress_automatic_thumbnail(uri, path, status, mime_type):
    if not thumbnail_relevant(mime_type): return
    metadata=path.stat()
    if not stat.S_ISREG(metadata.st_mode): return
    if not THUMBNAIL_WORK.claim(uri, (status, metadata.st_mtime_ns)): return
    try:
        mtime=int(metadata.st_mtime)
        digest=hashlib.md5(uri.encode("utf-8"), usedforsecurity=False).hexdigest()
        if status == "cloud-only":
            if not THUMBNAILS.has_valid_failed_thumbnail(uri, mtime): THUMBNAILS.create_failed_thumbnail(uri, mtime, None)
        elif status in {"cached", "pinned"}:
            failure_root=Path(os.environ.get("XDG_CACHE_HOME", str(Path.home()/".cache")))/"thumbnails"/"fail"
            for marker in failure_root.glob(f"*/{digest}.png"):
                try: marker.unlink()
                except OSError: pass
    except BaseException:
        THUMBNAIL_WORK.discard(uri)
        raise

def rpc(method, **params):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(.25); conn.connect(SOCKET); conn.sendall((json.dumps({"id":1,"method":method,"params":params})+"\n").encode()); data=b""
        while b"\n" not in data: data += conn.recv(65536)
    response=json.loads(data.split(b"\n",1)[0]);
    if "error" in response: raise RuntimeError(response["error"]["message"])
    return response["result"]

def run_actions(method, selected, extra):
    for node in selected:
        try: rpc(method, nodeId=node, **extra)
        except (OSError, RuntimeError, ValueError) as error:
            warn(f"action {method} failed for {node}", error)
            return

class OmarchyDriveExtension(GObject.GObject, Nautilus.MenuProvider, Nautilus.InfoProvider):
    def update_file_info(self, info):
        path=drive_path(info.get_uri(), MOUNT)
        if not path: return
        try:
            status=node_status(path)
            info.add_string_attribute("omarchy_drive_status", status)
            suppress_automatic_thumbnail(info.get_uri(), path, status, info.get_mime_type())
            emblem=EMBLEMS.get(status)
            if emblem: info.add_emblem(emblem)
        except (OSError, RuntimeError, ValueError) as error:
            warn(f"status update failed for {info.get_uri()}", error)
    def get_file_items(self, files):
        selected=[]; states=[]
        for info in files:
            path=drive_path(info.get_uri(), MOUNT)
            if not path: return []
            try:
                selected.append(node_id(path)); states.append({"status": node_status(path)})
            except (OSError, RuntimeError, ValueError) as error:
                warn(f"menu state failed for {info.get_uri()}", error)
                return []
        root=Nautilus.MenuItem(
            name="OmarchyDrive::root",
            label="Proton Drive",
            tip=l10n("Operacje na plikach Proton Drive", "Proton Drive file actions"),
        )
        menu=Nautilus.Menu(); root.set_submenu(menu)
        def item(key, label, method, **extra):
            action=Nautilus.MenuItem(name=f"OmarchyDrive::{key}", label=label, tip=label)
            action.connect("activate", lambda *_: threading.Thread(target=run_actions, args=(method, selected, extra), daemon=True).start()); menu.append_item(action)
        item("trash", l10n("Przenieś do kosza Proton Drive", "Move to Proton Drive trash"), "Trash")
        item("pin", l10n("Zawsze dostępny offline", "Always available offline"), "SetPinned", pinned=True)
        item("evict", l10n("Zwolnij miejsce lokalne", "Free local space"), "Evict")
        if states and all(state and state.get("status") in {"queued", "error"} for state in states):
            item("retry", l10n("Ponów synchronizację", "Retry sync"), "Retry")
        if len(selected) == 1 and states[0] and states[0].get("status") == "conflict":
            item("keep-local", l10n("Konflikt: zachowaj wersję lokalną", "Conflict: keep local version"), "ResolveConflict", resolution="keep-local")
            item("keep-remote", l10n("Konflikt: zachowaj wersję zdalną", "Conflict: keep remote version"), "ResolveConflict", resolution="keep-remote")
            item("save-both", l10n("Konflikt: zachowaj obie wersje", "Conflict: save both versions"), "ResolveConflict", resolution="save-both")
        return [root]
