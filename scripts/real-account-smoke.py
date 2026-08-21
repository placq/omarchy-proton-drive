#!/usr/bin/env python3
"""Destructive real-account smoke test, confined to /OmarchyDriveIntegrationTests/."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ipc.rpc_client import RpcClient

SOCKET = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")
CLI = os.environ.get("OMARCHY_DRIVE_CLI", str(Path.home() / ".local/bin/proton-drive"))
TEST_ROOT_NAME = "OmarchyDriveIntegrationTests"
RPC_CLIENT = RpcClient(SOCKET)


def rpc(method: str, **params):
    return RPC_CLIENT.call(method, **params)


def wait_for(node_id: str, wanted: set[str], timeout: float = 120) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = rpc("GetNodeStatus", nodeId=node_id) or {}
        if state.get("status") in wanted:
            return state
        time.sleep(0.25)
    raise TimeoutError(f"Node {node_id} did not reach {sorted(wanted)}")


def child(parent_id: str, name: str) -> dict | None:
    return next((item for item in rpc("ListChildren", nodeId=parent_id) if item["name"] == name), None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--confirm", action="store_true", help="allow temporary remote writes in the dedicated test directory")
    args = parser.parse_args()
    if not args.confirm:
        parser.error("pass --confirm to run remote mutations")
    status = rpc("GetStatus")
    if status.get("provider") != "proton-cli" or not status.get("authenticated") or status.get("readOnly"):
        raise RuntimeError("A signed-in writable proton-cli daemon is required")

    root = rpc("GetRoot")
    test_root = child(root["id"], TEST_ROOT_NAME)
    if test_root is None:
        test_root = rpc("CreateFolder", parentId=root["id"], name=TEST_ROOT_NAME)
    if test_root["kind"] != "folder":
        raise RuntimeError(f"/{TEST_ROOT_NAME} exists but is not a folder")

    run_name = f"smoke-{int(time.time())}"
    run_folder = rpc("CreateFolder", parentId=test_root["id"], name=run_name)
    try:
        node = rpc("CreateFile", parentId=run_folder["id"], name="write-test.txt")
        staging = Path(rpc("BeginWrite", nodeId=node["id"])["path"])
        staging.write_bytes(b"first real-account revision\n")
        rpc("CommitWrite", nodeId=node["id"])
        state = wait_for(node["id"], {"cached", "pinned", "error", "conflict"})
        if state["status"] not in {"cached", "pinned"}:
            raise RuntimeError(f"Initial upload failed safely: {state}")
        if Path(rpc("Materialize", nodeId=node["id"])["path"]).read_bytes() != b"first real-account revision\n":
            raise RuntimeError("Downloaded bytes differ from uploaded bytes")

        node = rpc("Rename", nodeId=node["id"], name="renamed.txt")
        nested = rpc("CreateFolder", parentId=run_folder["id"], name="nested")
        node = rpc("Move", nodeId=node["id"], parentId=nested["id"])
        if child(nested["id"], "renamed.txt") is None:
            raise RuntimeError("Moved file is not visible in its destination")

        rpc("SetPinned", nodeId=node["id"], pinned=True)
        if (rpc("GetNodeStatus", nodeId=node["id"]) or {}).get("status") != "pinned":
            raise RuntimeError("Pin did not become persistent")
        rpc("SetPinned", nodeId=node["id"], pinned=False)

        staging = Path(rpc("BeginWrite", nodeId=node["id"])["path"])
        staging.write_bytes(b"local conflict version\n")
        with tempfile.TemporaryDirectory(prefix="omarchy-drive-remote-") as temporary:
            remote_source = Path(temporary) / "renamed.txt"
            remote_source.write_bytes(b"remote conflict version\n")
            remote_parent = f"/my-files/{TEST_ROOT_NAME}/{run_name}/nested"
            subprocess.run(
                [CLI, "filesystem", "upload", "-f", "create-new-revision", "-t", str(remote_source), remote_parent, "-j"],
                check=True, stdout=subprocess.DEVNULL,
            )
        rpc("CommitWrite", nodeId=node["id"])
        conflict = wait_for(node["id"], {"conflict", "error", "cached"})
        if conflict["status"] != "conflict":
            raise RuntimeError(f"Revision race was not preserved as a conflict: {conflict}")
        resolved = rpc("ResolveConflict", nodeId=node["id"], resolution="save-both", copyName="local-copy.txt")
        if resolved.get("status") == "conflict" or child(nested["id"], "local-copy.txt") is None:
            raise RuntimeError("Save-both conflict resolution failed")
        local_copy = child(nested["id"], "local-copy.txt")
        local_bytes = Path(rpc("Materialize", nodeId=local_copy["id"])["path"]).read_bytes()
        if local_bytes != b"local conflict version\n":
            raise RuntimeError("Save-both did not preserve the local conflict bytes")
        print("PASS real account: create/read/edit/rename/move/pin/conflict-save-both/trash")
    finally:
        rpc("Trash", nodeId=run_folder["id"])


if __name__ == "__main__":
    main()
