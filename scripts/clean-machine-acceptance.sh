#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

usage() {
  local status=${1:-2}
  printf 'Usage: %s [--release-dir DIR] [--evidence FILE] [--confirm-dedicated-account] <preflight|snapshot-update|verify-update|verify-install|snapshot|verify-uninstall-refusal|verify-reinstall|status>\n' "$0" >&2
  exit "$status"
}

release_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
evidence="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-drive/release-gate/clean-machine.json"
dedicated=false
while (($#)); do
  case $1 in
    --release-dir) (($# >= 2)) || usage; release_dir=$(realpath "$2"); shift 2 ;;
    --evidence) (($# >= 2)) || usage; evidence=$2; shift 2 ;;
    --confirm-dedicated-account) dedicated=true; shift ;;
    -h|--help) usage 0 ;;
    --*) usage ;;
    *) command=$1; shift; (($# == 0)) || usage; break ;;
  esac
done
[[ ${command:-} =~ ^(preflight|snapshot-update|verify-update|verify-install|snapshot|verify-uninstall-refusal|verify-reinstall|status)$ ]] || usage

archive_path() {
  local archives=("$release_dir"/omarchy-drive-*.tar.gz)
  ((${#archives[@]} == 1)) || { printf 'Expected exactly one release archive in %s\n' "$release_dir" >&2; return 1; }
  printf '%s\n' "${archives[0]}"
}

release_version() {
  local archive
  archive=$(basename "$(archive_path)")
  printf '%s\n' "${archive#omarchy-drive-}" | sed 's/\.tar\.gz$//'
}

verify_release() {
  [[ -f $release_dir/SHA256SUMS && -f $release_dir/PKGBUILD ]] || { printf 'Release files are incomplete in %s\n' "$release_dir" >&2; return 1; }
  (cd "$release_dir" && sha256sum --check --strict SHA256SUMS)
  local version pkgver
  version=$(release_version); pkgver=${version/-alpha./_alpha}
  grep -Fqx "pkgver=$pkgver" "$release_dir/PKGBUILD" || { printf 'Release PKGBUILD version mismatch\n' >&2; return 1; }
}

with_source() {
  local temporary archive source status
  temporary=$(mktemp -d /tmp/omarchy-drive-release-source.XXXXXX)
  archive=$(archive_path)
  tar -xzf "$archive" -C "$temporary"
  source=$(find "$temporary" -mindepth 1 -maxdepth 1 -type d -name 'omarchy-drive-*' -print -quit)
  if [[ -z $source ]]; then
    printf 'Release archive has no expected source root\n' >&2
    rm -rf -- "$temporary"
    return 1
  fi
  if "$@" "$source"; then status=0; else status=$?; fi
  rm -rf -- "$temporary"
  return "$status"
}

initialize_evidence() {
  local version archive_sha machine_data temporary
  version=$(release_version)
  archive_sha=$(sha256sum "$(archive_path)" | awk '{print $1}')
  machine_data=$(python3 - <<'PY'
import json, os, platform, subprocess
commands = {
    "omarchy": ["omarchy", "--version"],
    "bun": ["bun", "--version"],
    "python": ["python3", "--version"],
    "nautilus": ["nautilus", "--version"],
    "fusermount": ["fusermount3", "--version"],
}
versions = {}
for name, command in commands.items():
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        value = (result.stdout or result.stderr).splitlines()
        versions[name] = value[0][:200] if value else f"exit {result.returncode}"
    except Exception as error:
        versions[name] = type(error).__name__
print(json.dumps({"kernel": platform.release(), "machine": platform.machine(), "versions": versions}, sort_keys=True))
PY
)
  temporary=$(mktemp "${evidence}.XXXXXX")
  python3 - "$version" "$archive_sha" "$machine_data" > "$temporary" <<'PY'
import json, sys, time
print(json.dumps({
    "schema": 1,
    "createdAt": int(time.time()),
    "releaseVersion": sys.argv[1],
    "archiveSha256": sys.argv[2],
    "machine": json.loads(sys.argv[3]),
    "passed": {"preflight": int(time.time())},
}, indent=2, sort_keys=True))
PY
  chmod 600 "$temporary"; mv -f -- "$temporary" "$evidence"
}

update_evidence() {
  local phase=$1 value=${2:-null} temporary
  temporary=$(mktemp "${evidence}.XXXXXX")
  python3 - "$evidence" "$phase" "$value" > "$temporary" <<'PY'
import json, sys, time
with open(sys.argv[1], encoding="utf-8") as stream:
    data = json.load(stream)
data.setdefault("passed", {})[sys.argv[2]] = json.loads(sys.argv[3])
data["updatedAt"] = int(time.time())
print(json.dumps(data, indent=2, sort_keys=True))
PY
  chmod 600 "$temporary"; mv -f -- "$temporary" "$evidence"
}

require_evidence() {
  verify_release
  [[ -f $evidence ]] || { printf 'Run preflight first; evidence is missing: %s\n' "$evidence" >&2; exit 1; }
  python3 - "$evidence" "$(release_version)" "$(sha256sum "$(archive_path)" | awk '{print $1}')" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    data = json.load(stream)
if data.get("schema") != 1 or data.get("releaseVersion") != sys.argv[2] or data.get("archiveSha256") != sys.argv[3]:
    raise SystemExit("Evidence does not belong to this release artifact")
PY
}

run_doctor() {
  local source=$1
  "$source/scripts/doctor.sh"
}

verify_installed() {
  local version package expected_package status_json plugin_manifest source=$1
  version=$(release_version); expected_package=${version/-alpha./_alpha}
  package=$(pacman -Q omarchy-drive 2>/dev/null) || { printf 'omarchy-drive package is not installed\n' >&2; return 1; }
  [[ $package == "omarchy-drive $expected_package-"* ]] || { printf 'Installed package does not match release: %s\n' "$package" >&2; return 1; }
  status_json=$(timeout 20s omarchy-drive-control status)
  python3 - "$version" "$status_json" <<'PY'
import json, sys
status=json.loads(sys.argv[2])
if status.get("version") != sys.argv[1] or status.get("apiVersion") != 1:
    raise SystemExit("Installed daemon/API version mismatch")
PY
  plugin_manifest="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/placq.proton-drive/manifest.json"
  [[ -f $plugin_manifest ]] || { printf 'Installed plugin manifest is missing\n' >&2; return 1; }
  python3 - "$plugin_manifest" "$version" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    manifest=json.load(stream)
if manifest.get("version") != sys.argv[2]: raise SystemExit("Installed plugin version mismatch")
PY
  omarchy plugin validate "$(dirname "$plugin_manifest")"
  run_doctor "$source"
}

state_snapshot() {
  python3 - "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-drive/state-proton-cli.sqlite" <<'PY'
import hashlib, json, os, sqlite3, sys
path=sys.argv[1]
connection=sqlite3.connect(f"file:{path}?mode=ro", uri=True)
try:
    states=[json.loads(row[0]) for row in connection.execute("SELECT json FROM states")]
finally:
    connection.close()
def anonymous(value): return hashlib.sha256(value.encode()).hexdigest()
def combined(values): return hashlib.sha256("\n".join(sorted(values)).encode()).hexdigest()
pinned=[]; staging=[]; conflicts=[]; state_nodes=[]
for state in states:
    node=anonymous(str(state.get("nodeId", "")))
    state_nodes.append(node)
    if state.get("pinned"): pinned.append(node)
    stage=state.get("stagingPath")
    if stage:
        if not os.path.isfile(stage): raise SystemExit("Recorded staging path is missing")
        digest=hashlib.sha256()
        with open(stage, "rb") as stream:
            while chunk := stream.read(1024*1024): digest.update(chunk)
        item=f"{node}:{digest.hexdigest()}"
        staging.append(item)
        if state.get("status") == "conflict": conflicts.append(item)
database=os.stat(path)
print(json.dumps({
    "stateFilePresent": True,
    "stateCount": len(states), "stateNodeDigest": combined(state_nodes),
    "databaseDevice": database.st_dev, "databaseInode": database.st_ino,
    "pinnedCount": len(pinned), "pinnedDigest": combined(pinned),
    "stagingCount": len(staging), "stagingDigest": combined(staging),
    "conflictCount": len(conflicts), "conflictDigest": combined(conflicts),
}, sort_keys=True))
PY
}

authenticated() {
  timeout 20s omarchy-drive-control status | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("authenticated") else "false")'
}

compare_snapshot() {
  local current=$1 key=${2:-snapshot}
  python3 - "$evidence" "$current" "$key" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream: evidence=json.load(stream)
expected=evidence.get(sys.argv[3])
current=json.loads(sys.argv[2])
if not expected: raise SystemExit(f"Missing evidence snapshot: {sys.argv[3]}")
for field in ("stateCount", "stateNodeDigest", "databaseDevice", "databaseInode", "pinnedCount", "pinnedDigest", "stagingCount", "stagingDigest", "conflictCount", "conflictDigest"):
    if expected.get(field) != current.get(field): raise SystemExit(f"State preservation failed: {field}")
PY
}

case $command in
  preflight)
    ((EUID != 0)) || { printf 'Run acceptance as the target desktop user, never root.\n' >&2; exit 1; }
    for tool in omarchy makepkg git bun python3 pacman sha256sum tar; do command -v "$tool" >/dev/null || { printf 'Missing clean-machine tool: %s\n' "$tool" >&2; exit 1; }; done
    if git -C "$release_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf 'Release directory is inside a Git checkout; copy only dist/<version>/ to the clean machine.\n' >&2; exit 1
    fi
    verify_release
    mkdir -p "$(dirname "$evidence")"; chmod 700 "$(dirname "$evidence")"
    initialize_evidence
    printf 'PASS checksummed release preflight; install only from %s, then run verify-install.\n' "$release_dir"
    ;;
  verify-install)
    require_evidence; verify_release
    with_source verify_installed
    update_evidence installVerified "$(date +%s)"
    printf 'PASS artifact/package/plugin/services/doctor verification\n'
    ;;
  snapshot-update)
    require_evidence
    $dedicated || { printf 'Update snapshot requires --confirm-dedicated-account.\n' >&2; exit 2; }
    previous_package=$(pacman -Q omarchy-drive 2>/dev/null) || { printf 'Install the previous checksummed release before snapshot-update.\n' >&2; exit 1; }
    current_version=$(release_version); current_pkgver=${current_version/-alpha./_alpha}; expected="omarchy-drive $current_pkgver-"
    [[ $previous_package != "$expected"* ]] || { printf 'Current release is already installed; an in-place update is not proven.\n' >&2; exit 1; }
    [[ $(authenticated) == true ]] || { printf 'Authenticate the dedicated account before the update snapshot.\n' >&2; exit 1; }
    update_snapshot=$(state_snapshot)
    temporary=$(mktemp "${evidence}.XXXXXX")
    python3 - "$evidence" "$update_snapshot" "$previous_package" > "$temporary" <<'PY'
import json, sys, time
with open(sys.argv[1], encoding="utf-8") as stream: data=json.load(stream)
data["updateSnapshot"]=json.loads(sys.argv[2]); data["previousPackage"]=sys.argv[3]
data.setdefault("passed", {})["updateSnapshot"] = int(time.time())
print(json.dumps(data, indent=2, sort_keys=True))
PY
    chmod 600 "$temporary"; mv -f -- "$temporary" "$evidence"
    printf 'PASS pre-update state/session snapshot; install the current checksummed artifact, then run verify-update.\n'
    ;;
  verify-update)
    require_evidence
    $dedicated || { printf 'Update verification requires --confirm-dedicated-account.\n' >&2; exit 2; }
    with_source verify_installed
    current=$(state_snapshot); compare_snapshot "$current" updateSnapshot
    [[ $(authenticated) == true ]] || { printf 'Secret Service session was not preserved across update.\n' >&2; exit 1; }
    update_evidence updateVerified "$(date +%s)"
    printf 'PASS in-place artifact update preserved session, SQLite, pins, staging and conflicts\n'
    ;;
  snapshot)
    require_evidence
    $dedicated || { printf 'Snapshot requires --confirm-dedicated-account.\n' >&2; exit 2; }
    snapshot=$(state_snapshot)
    python3 - "$snapshot" <<'PY'
import json, sys
value=json.loads(sys.argv[1])
if value["pinnedCount"] < 1 or value["stagingCount"] < 1 or value["conflictCount"] < 1:
    raise SystemExit("Create disposable pinned, staged and conflicted fixtures under /OmarchyDriveIntegrationTests first")
PY
    temporary=$(mktemp "${evidence}.XXXXXX")
    python3 - "$evidence" "$snapshot" > "$temporary" <<'PY'
import json, sys, time
with open(sys.argv[1], encoding="utf-8") as stream: data=json.load(stream)
data["snapshot"]=json.loads(sys.argv[2]); data.setdefault("passed", {})["snapshot"] = int(time.time())
print(json.dumps(data, indent=2, sort_keys=True))
PY
    chmod 600 "$temporary"; mv -f -- "$temporary" "$evidence"
    printf 'PASS anonymized SQLite/pin/staging/conflict snapshot\n'
    ;;
  verify-uninstall-refusal)
    require_evidence
    $dedicated || { printf 'Uninstall refusal requires --confirm-dedicated-account.\n' >&2; exit 2; }
    before=$(state_snapshot); compare_snapshot "$before"
    set +e
    output=$(with_source bash -c '"$1/scripts/uninstall.sh"' _ 2>&1)
    status=$?
    set -e
    if ((status != 2)) || [[ $output != *'Cannot safely remove integration'* ]]; then
      printf 'Unsafe uninstall did not refuse as required (status %s).\n' "$status" >&2; exit 1
    fi
    after=$(state_snapshot); compare_snapshot "$after"
    systemctl --user is-active --quiet omarchy-drive.service
    update_evidence uninstallRefused "$(date +%s)"
    printf 'PASS installed uninstall refused and preserved exact staged/conflict bytes\n'
    ;;
  verify-reinstall)
    require_evidence
    $dedicated || { printf 'Reinstall verification requires --confirm-dedicated-account.\n' >&2; exit 2; }
    with_source verify_installed
    current=$(state_snapshot); compare_snapshot "$current"
    [[ $(authenticated) == true ]] || { printf 'Secret Service session was not preserved across reinstall.\n' >&2; exit 1; }
    update_evidence reinstallVerified "$(date +%s)"
    printf 'PASS reinstall preserved session, SQLite, pins, staging and conflicts\n'
    ;;
  status)
    require_evidence
    python3 - "$evidence" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream: data=json.load(stream)
required={"preflight", "updateSnapshot", "updateVerified", "installVerified", "snapshot", "uninstallRefused", "reinstallVerified"}
passed=set(data.get("passed", {}))
print(json.dumps({"releaseVersion": data.get("releaseVersion"), "passed": sorted(passed), "missing": sorted(required-passed), "complete": required <= passed}, indent=2, sort_keys=True))
PY
    ;;
esac
