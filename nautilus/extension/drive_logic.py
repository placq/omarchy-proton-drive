"""Pure Nautilus integration helpers; intentionally free of GTK/Nautilus imports."""
from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import unquote, urlparse


def drive_path(uri: str, mount: Path) -> Path | None:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return None
    path = Path(unquote(parsed.path)).resolve()
    try:
        path.relative_to(mount.resolve())
        return path
    except ValueError:
        return None


def node_id(path: Path) -> str:
    value = os.getxattr(path, "user.omarchy-drive.node-id").decode("utf-8")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", value):
        raise ValueError("invalid node id")
    return value
