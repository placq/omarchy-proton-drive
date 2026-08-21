#!/usr/bin/env python3
"""Stateful 1.0 recovery gate for a dedicated Proton test account.

Every remote mutation is confined to /OmarchyDriveIntegrationTests/recovery-*/.
The script never stores account identity, credentials, tokens, or raw journal data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ipc.rpc_client import RpcClient, RpcError

TEST_ROOT_NAME = "OmarchyDriveIntegrationTests"
RUN_PREFIX = "recovery-"
SERVICE = "omarchy-drive.service"
SOCKET = os.environ.get("OMARCHY_DRIVE_SOCKET", f"{os.environ.get('XDG_RUNTIME_DIR', '/tmp')}/omarchy-drive.sock")
STATE_HOME = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
DEFAULT_EVIDENCE = STATE_HOME / "omarchy-drive/release-gate/recovery.json"
RPC = RpcClient(SOCKET)
MUTATING_COMMANDS = {
    "setup", "stage-offline", "interrupt-upload", "interrupt-download",
    "stage-rate-limit", "cleanup",
}


def rpc(method: str, **params):
    return RPC.call(method, **params)


def boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=True, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def load_evidence(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        evidence = json.load(stream)
    if evidence.get("schema") != 1 or not str(evidence.get("runName", "")).startswith(RUN_PREFIX):
        raise RuntimeError(f"Invalid recovery evidence: {path}")
    return evidence


def save_evidence(path: Path, evidence: dict) -> None:
    evidence["updatedAt"] = int(time.time())
    atomic_json(path, evidence)


def child(parent_id: str, name: str) -> dict | None:
    return next((node for node in rpc("ListChildren", nodeId=parent_id) if node.get("name") == name), None)


def require_real_account() -> dict:
    status = rpc("GetStatus")
    if status.get("provider") != "proton-cli" or status.get("readOnly"):
        raise RuntimeError("The installed writable proton-cli provider is required")
    return status


def require_authenticated() -> dict:
    status = require_real_account()
    if not status.get("authenticated") or not status.get("connected"):
        raise RuntimeError("A connected dedicated Proton test account is required")
    return status


def locate_fixture(evidence: dict) -> tuple[dict, dict, dict]:
    root = rpc("GetRoot")
    test_root = child(root["id"], TEST_ROOT_NAME)
    if not test_root or test_root.get("kind") != "folder":
        raise RuntimeError(f"/{TEST_ROOT_NAME} is missing")
    run = child(test_root["id"], evidence["runName"])
    if not run or run.get("kind") != "folder":
        raise RuntimeError("The recorded recovery fixture is missing")
    if run.get("id") != evidence.get("runFolderId"):
        raise RuntimeError("Recovery fixture identity changed; refusing mutation")
    remote_files = {node.get("name"): node for node in rpc("ListChildren", nodeId=run["id"])}
    for entry in evidence.get("files", {}).values():
        remote = remote_files.get(entry.get("name"))
        if not remote or remote.get("kind") != "file" or remote.get("id") != entry.get("id"):
            raise RuntimeError("Recorded recovery file identity changed; refusing mutation")
    return root, test_root, run


def wait_for_state(node_id: str, wanted: set[str], timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    last: dict = {}
    while time.monotonic() < deadline:
        last = rpc("GetNodeStatus", nodeId=node_id) or {}
        if last.get("status") in wanted:
            return last
        time.sleep(0.25)
    raise TimeoutError(f"Node {node_id} did not reach {sorted(wanted)}; last status={last.get('status')}")


def write_payload(path: Path, label: str, size: int) -> str:
    if size < 1:
        raise ValueError("Payload size must be positive")
    seed = hashlib.sha256(label.encode("utf-8")).digest()
    digest = hashlib.sha256()
    remaining = size
    counter = 0
    with path.open("wb") as stream:
        while remaining:
            block = hashlib.sha256(seed + counter.to_bytes(8, "big")).digest() * 2048
            block = block[:min(remaining, len(block))]
            stream.write(block)
            digest.update(block)
            remaining -= len(block)
            counter += 1
        stream.flush()
        os.fsync(stream.fileno())
    return digest.hexdigest()


def stage_payload(node_id: str, label: str, size: int) -> tuple[Path, str]:
    staging = Path(rpc("BeginWrite", nodeId=node_id)["path"])
    digest = write_payload(staging, label, size)
    rpc("CommitWrite", nodeId=node_id)
    return staging, digest


def assert_staging(node_id: str, digest: str, allowed: set[str]) -> dict:
    state = rpc("GetNodeStatus", nodeId=node_id) or {}
    if state.get("status") not in allowed:
        raise RuntimeError(f"Expected recoverable status {sorted(allowed)}, got {state.get('status')}")
    staging_value = state.get("stagingPath")
    if not staging_value:
        raise RuntimeError("Recovery state does not reference persistent staging")
    staging = Path(staging_value)
    if not staging.is_file() or sha256_file(staging) != digest:
        raise RuntimeError("Persistent staging bytes do not match the recorded SHA-256")
    return state


def verify_remote_bytes(node_id: str, digest: str) -> None:
    state = wait_for_state(node_id, {"cached", "pinned"}, 420)
    if state.get("stagingPath"):
        raise RuntimeError("Upload reports completion but staging is still attached")
    rpc("Evict", nodeId=node_id)
    downloaded = Path(rpc("Materialize", nodeId=node_id)["path"])
    if sha256_file(downloaded) != digest:
        raise RuntimeError("Freshly downloaded remote bytes do not match the recorded SHA-256")


def main_pid() -> int:
    result = subprocess.run(
        ["systemctl", "--user", "show", SERVICE, "--property=MainPID", "--value"],
        check=True, text=True, capture_output=True,
    )
    return int(result.stdout.strip() or "0")


def wait_for_daemon(previous_pid: int, timeout: float = 45) -> int:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            pid = main_pid()
            if pid and pid != previous_pid:
                rpc("GetVersion")
                return pid
        except (OSError, RpcError, subprocess.SubprocessError, ValueError) as error:
            last_error = str(error)
        time.sleep(0.25)
    raise TimeoutError(f"Daemon did not restart with a new PID: {last_error}")


def kill_daemon_during(direction: str, node_id: str, operation: Callable[[], None] | None = None) -> tuple[int, int]:
    failure: list[BaseException] = []
    worker = None
    if operation is not None:
        def run_operation() -> None:
            try:
                operation()
            except BaseException as error:  # expected when the daemon is killed
                failure.append(error)
        worker = threading.Thread(target=run_operation, daemon=True)
        worker.start()
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        transfers = rpc("GetTransfers")
        running = any(
            item.get("nodeId") == node_id and item.get("direction") == direction and item.get("state") == "running"
            for item in transfers
        )
        if running:
            break
        state = rpc("GetNodeStatus", nodeId=node_id) or {}
        if direction == "upload" and state.get("status") in {"cached", "pinned"}:
            raise RuntimeError("Upload completed before interruption; repeat with a larger --size-mib")
        time.sleep(0.05)
    else:
        raise TimeoutError(f"No running {direction} transfer was observed")
    previous_pid = main_pid()
    if previous_pid <= 0:
        raise RuntimeError("Daemon service has no running MainPID")
    subprocess.run(
        ["systemctl", "--user", "kill", "--signal=KILL", SERVICE],
        check=True, stdout=subprocess.DEVNULL,
    )
    new_pid = wait_for_daemon(previous_pid)
    if worker is not None:
        worker.join(10)
        if worker.is_alive():
            raise RuntimeError("Interrupted RPC worker did not terminate")
        if not failure:
            raise RuntimeError("Download RPC unexpectedly completed before daemon termination")
    return previous_pid, new_pid


def setup(args: argparse.Namespace, evidence_path: Path) -> None:
    if evidence_path.exists():
        raise RuntimeError(f"Recovery evidence already exists: {evidence_path}; finish or clean it first")
    require_authenticated()
    root = rpc("GetRoot")
    test_root = child(root["id"], TEST_ROOT_NAME)
    if test_root is None:
        test_root = rpc("CreateFolder", parentId=root["id"], name=TEST_ROOT_NAME)
    if test_root.get("kind") != "folder":
        raise RuntimeError(f"/{TEST_ROOT_NAME} exists but is not a folder")
    run_name = f"{RUN_PREFIX}{int(time.time())}-{os.getpid()}"
    run = rpc("CreateFolder", parentId=test_root["id"], name=run_name)
    files = {}
    for key, name in {
        "offline": "offline-reboot.bin",
        "interrupt": "interrupted-transfer.bin",
        "rateLimit": "rate-limit.bin",
    }.items():
        node = rpc("CreateFile", parentId=run["id"], name=name)
        wait_for_state(node["id"], {"cached", "pinned"}, 120)
        files[key] = {"id": node["id"], "name": name}
    evidence = {
        "schema": 1,
        "createdAt": int(time.time()),
        "initialBootId": boot_id(),
        "runName": run_name,
        "runFolderId": run["id"],
        "files": files,
        "passed": {},
    }
    save_evidence(evidence_path, evidence)
    print(f"Prepared /{TEST_ROOT_NAME}/{run_name}/")
    print("Disconnect networking, then run stage-offline --confirm.")


def stage_offline(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    locate_fixture(evidence)
    entry = evidence["files"]["offline"]
    label = f"offline-reboot:{evidence['runName']}"
    _staging, digest = stage_payload(entry["id"], label, args.payload_bytes)
    deadline = time.monotonic() + args.settle_seconds
    while time.monotonic() < deadline:
        state = rpc("GetNodeStatus", nodeId=entry["id"]) or {}
        if state.get("status") in {"cached", "pinned"}:
            raise RuntimeError("Upload succeeded: networking was not offline for the recovery gate")
        time.sleep(0.25)
    assert_staging(entry["id"], digest, {"dirty", "queued", "error"})
    entry.update({"sha256": digest})
    evidence["offlineStagedBootId"] = boot_id()
    evidence["offlineStagedAt"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print(f"Persistent offline staging verified: sha256={digest}")
    print("Reboot while still offline, reconnect networking after login, then run verify-reconnect.")


def verify_reconnect(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    require_authenticated()
    locate_fixture(evidence)
    staged_boot = evidence.get("offlineStagedBootId")
    if not staged_boot:
        raise RuntimeError("stage-offline has not completed")
    if boot_id() == staged_boot:
        raise RuntimeError("boot_id did not change; the required reboot is not proven")
    entry = evidence["files"]["offline"]
    verify_remote_bytes(entry["id"], entry["sha256"])
    evidence["passed"]["offlineRebootReconnect"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print("PASS offline edit -> reboot -> reconnect with exact remote bytes")


def interrupt_upload(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    require_authenticated(); locate_fixture(evidence)
    entry = evidence["files"]["interrupt"]
    size = args.size_mib * 1024 * 1024
    staging = Path(rpc("BeginWrite", nodeId=entry["id"])["path"])
    digest = write_payload(staging, f"interrupted-upload:{evidence['runName']}", size)
    rpc("CommitWrite", nodeId=entry["id"])
    old_pid, new_pid = kill_daemon_during("upload", entry["id"])
    recovered = wait_for_state(entry["id"], {"queued", "error", "cached", "pinned"}, 30)
    if recovered.get("status") in {"queued", "error"}:
        assert_staging(entry["id"], digest, {"queued", "error"})
    verify_remote_bytes(entry["id"], digest)
    entry["sha256"] = digest
    evidence["passed"]["interruptedUpload"] = {"at": int(time.time()), "oldPid": old_pid, "newPid": new_pid}
    save_evidence(evidence_path, evidence)
    print("PASS killed upload -> daemon restart -> automatic retry -> exact remote bytes")


def interrupt_download(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    require_authenticated(); locate_fixture(evidence)
    entry = evidence["files"]["interrupt"]
    if not entry.get("sha256") or "interruptedUpload" not in evidence["passed"]:
        raise RuntimeError("interrupt-upload must pass first")
    rpc("Evict", nodeId=entry["id"])
    old_pid, new_pid = kill_daemon_during(
        "download", entry["id"],
        operation=lambda: rpc("Materialize", nodeId=entry["id"]),
    )
    downloaded = Path(rpc("Materialize", nodeId=entry["id"])["path"])
    if sha256_file(downloaded) != entry["sha256"]:
        raise RuntimeError("Retried download bytes differ from the uploaded fixture")
    evidence["passed"]["interruptedDownload"] = {"at": int(time.time()), "oldPid": old_pid, "newPid": new_pid}
    save_evidence(evidence_path, evidence)
    print("PASS killed download -> daemon restart -> retry without shell restart -> exact bytes")


def stage_rate_limit(args: argparse.Namespace, evidence_path: Path) -> None:
    if not args.confirm_rate_limit_observed:
        raise RuntimeError("Pass --confirm-rate-limit-observed only after observing a real provider rate limit")
    evidence = load_evidence(evidence_path)
    locate_fixture(evidence)
    entry = evidence["files"]["rateLimit"]
    _staging, digest = stage_payload(entry["id"], f"rate-limit:{evidence['runName']}", args.payload_bytes)
    deadline = time.monotonic() + args.settle_seconds
    while time.monotonic() < deadline:
        state = rpc("GetNodeStatus", nodeId=entry["id"]) or {}
        if state.get("status") in {"cached", "pinned"}:
            raise RuntimeError("Upload succeeded; no real rate-limited failure was observed")
        time.sleep(0.25)
    state = assert_staging(entry["id"], digest, {"queued", "error"})
    if not state.get("error"):
        raise RuntimeError("The rate-limit gate requires an observed provider failure")
    entry.update({"sha256": digest})
    evidence["rateLimitObservedAt"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print(f"PASS real provider failure retained exact staging bytes: sha256={digest}")


def verify_rate_limit_recovery(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    require_authenticated(); locate_fixture(evidence)
    entry = evidence["files"]["rateLimit"]
    if not entry.get("sha256") or not evidence.get("rateLimitObservedAt"):
        raise RuntimeError("stage-rate-limit has not recorded a real failure")
    verify_remote_bytes(entry["id"], entry["sha256"])
    evidence["passed"]["rateLimitRecovery"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print("PASS rate-limited staging automatically recovered with exact remote bytes")


def verify_revoked(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    deadline = time.monotonic() + args.timeout
    while True:
        status = require_real_account()
        if not status.get("authenticated") and status.get("account") is None:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Session still appears authenticated; revoke it in Proton security settings first")
        time.sleep(1)
    if status.get("connectionError"):
        raise RuntimeError("Revoked session was presented as a generic connection failure")
    evidence["passed"]["revokedSession"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print("PASS revoked session exposes signed-out state without stale account data")
    print("Confirm the widget shows Zaloguj się, authenticate again, then run verify-reauth.")


def verify_reauth(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    deadline = time.monotonic() + args.timeout
    while True:
        try:
            require_authenticated(); break
        except RuntimeError:
            if time.monotonic() >= deadline: raise
            time.sleep(1)
    locate_fixture(evidence)
    if "revokedSession" not in evidence["passed"]:
        raise RuntimeError("verify-revoked must pass first")
    evidence["passed"]["reauthenticated"] = int(time.time())
    save_evidence(evidence_path, evidence)
    print("PASS authentication recovered without replacing local recovery evidence")


def redaction_findings(text: str, evidence: dict, forbidden: list[str]) -> list[str]:
    labels = {
        "authorization header": "authorization:",
        "bearer credential": "bearer ",
        "access token": "access_token",
        "refresh token": "refresh_token",
        "password field": "password",
        "test run folder": evidence["runName"].lower(),
    }
    for entry in evidence["files"].values():
        labels[f"test filename {entry['name']}"] = entry["name"].lower()
    for index, value in enumerate(forbidden):
        labels[f"operator forbidden value {index + 1}"] = value.lower()
    lowered = text.lower()
    return [label for label, needle in labels.items() if needle and needle in lowered]


def audit_logs(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    forbidden: list[str] = []
    if args.forbid_file:
        mode = args.forbid_file.stat().st_mode & 0o777
        if mode & 0o077:
            raise RuntimeError("--forbid-file must not be readable by group or others")
        forbidden = [line.strip() for line in args.forbid_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    since = int(evidence["createdAt"])
    result = subprocess.run(
        [
            "journalctl", "--user", "--no-pager", "--output=cat", f"--since=@{since}",
            "-u", "omarchy-drive.service", "-u", "omarchy-drive-dbus.service", "-u", "omarchy-drive-mount.service",
        ],
        check=True, text=True, capture_output=True,
    )
    failures = redaction_findings(result.stdout, evidence, forbidden)
    if failures:
        raise RuntimeError("Journal redaction failed for: " + ", ".join(failures))
    evidence["passed"]["journalRedaction"] = {"at": int(time.time()), "entries": len(result.stdout.splitlines())}
    save_evidence(evidence_path, evidence)
    print(f"PASS journal redaction scan ({len(result.stdout.splitlines())} entries; raw log not retained)")


def show_status(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    required = {
        "offlineRebootReconnect", "interruptedUpload", "interruptedDownload",
        "rateLimitRecovery", "revokedSession", "reauthenticated", "journalRedaction",
    }
    passed = set(evidence.get("passed", {}))
    print(json.dumps({
        "runName": evidence["runName"],
        "passed": sorted(passed),
        "missing": sorted(required - passed),
        "complete": required <= passed,
    }, indent=2, sort_keys=True))


def cleanup(args: argparse.Namespace, evidence_path: Path) -> None:
    evidence = load_evidence(evidence_path)
    require_authenticated()
    _, _, run = locate_fixture(evidence)
    rpc("Trash", nodeId=run["id"])
    evidence_path.unlink()
    print(f"Trashed /{TEST_ROOT_NAME}/{evidence['runName']}/ and removed local evidence")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--confirm", action="store_true", help="allow scoped remote writes and deliberate daemon interruption")
    result.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    sub = result.add_subparsers(dest="command", required=True)
    sub.add_parser("setup")
    offline = sub.add_parser("stage-offline")
    offline.add_argument("--payload-bytes", type=int, default=4096)
    offline.add_argument("--settle-seconds", type=float, default=8)
    upload = sub.add_parser("interrupt-upload")
    upload.add_argument("--size-mib", type=int, default=64)
    sub.add_parser("interrupt-download")
    rate = sub.add_parser("stage-rate-limit")
    rate.add_argument("--payload-bytes", type=int, default=4096)
    rate.add_argument("--settle-seconds", type=float, default=8)
    rate.add_argument("--confirm-rate-limit-observed", action="store_true")
    sub.add_parser("verify-reconnect")
    sub.add_parser("verify-rate-limit-recovery")
    revoked = sub.add_parser("verify-revoked")
    revoked.add_argument("--timeout", type=float, default=420)
    reauth = sub.add_parser("verify-reauth")
    reauth.add_argument("--timeout", type=float, default=120)
    logs = sub.add_parser("audit-logs")
    logs.add_argument("--forbid-file", type=Path, help="private 0600 file of additional account-specific values, one per line")
    sub.add_parser("status")
    sub.add_parser("cleanup")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.command in MUTATING_COMMANDS and not args.confirm:
        raise SystemExit(f"{args.command} changes the dedicated fixture or daemon; pass --confirm")
    handlers = {
        "setup": setup,
        "stage-offline": stage_offline,
        "verify-reconnect": verify_reconnect,
        "interrupt-upload": interrupt_upload,
        "interrupt-download": interrupt_download,
        "stage-rate-limit": stage_rate_limit,
        "verify-rate-limit-recovery": verify_rate_limit_recovery,
        "verify-revoked": verify_revoked,
        "verify-reauth": verify_reauth,
        "audit-logs": audit_logs,
        "status": show_status,
        "cleanup": cleanup,
    }
    handlers[args.command](args, args.evidence.expanduser())


if __name__ == "__main__":
    main()
