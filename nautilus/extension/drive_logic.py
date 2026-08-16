"""Pure Nautilus integration helpers; intentionally free of GTK/Nautilus imports."""
from __future__ import annotations

import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Hashable
from urllib.parse import unquote, urlparse


def drive_path(uri: str, mount: Path) -> Path | None:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return None
    path = Path(os.path.abspath(os.path.normpath(unquote(parsed.path))))
    try:
        path.relative_to(mount)
        return path
    except ValueError:
        return None


def node_id(path: Path) -> str:
    value = os.getxattr(path, "user.omarchy-drive.node-id").decode("utf-8")
    if not re.fullmatch(r"[A-Za-z0-9._~=-]+", value):
        raise ValueError("invalid node id")
    return value


VALID_STATUSES = {"cloud-only", "downloading", "cached", "pinned", "dirty", "queued", "uploading", "conflict", "error"}


def node_status(path: Path) -> str:
    value = os.getxattr(path, "user.omarchy-drive.status").decode("utf-8")
    if value not in VALID_STATUSES:
        raise ValueError("invalid node status")
    return value


def thumbnail_relevant(mime_type: str | None) -> bool:
    if not mime_type:
        return False
    return mime_type.startswith(("image/", "video/", "audio/")) or mime_type in {
        "application/pdf",
        "application/epub+zip",
        "application/vnd.oasis.opendocument.presentation",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.text",
    }


class ThumbnailWorkCache:
    """Bound repeated thumbnail bookkeeping performed by Nautilus InfoProvider."""

    def __init__(self, max_entries: int = 4096):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        self.max_entries = max_entries
        self._fingerprints: OrderedDict[str, Hashable] = OrderedDict()

    def claim(self, uri: str, fingerprint: Hashable) -> bool:
        if self._fingerprints.get(uri) == fingerprint:
            self._fingerprints.move_to_end(uri)
            return False
        self._fingerprints[uri] = fingerprint
        self._fingerprints.move_to_end(uri)
        while len(self._fingerprints) > self.max_entries:
            self._fingerprints.popitem(last=False)
        return True

    def discard(self, uri: str) -> None:
        self._fingerprints.pop(uri, None)
