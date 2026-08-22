#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for command in dbus-run-session gdbus python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    if [[ ${OMARCHY_DRIVE_REQUIRE_DBUS_TEST:-0} == 1 ]]; then
      printf 'Missing required D-Bus test command: %s\n' "$command" >&2
      exit 1
    fi
    printf 'Skipping D-Bus runtime test: %s is unavailable.\n' "$command"
    exit 0
  fi
done
if ! python3 -c 'import dbus_next' >/dev/null 2>&1; then
  if [[ ${OMARCHY_DRIVE_REQUIRE_DBUS_TEST:-0} == 1 ]]; then
    printf 'Missing required Python module: dbus_next\n' >&2
    exit 1
  fi
  printf 'Skipping D-Bus runtime test: dbus_next is unavailable.\n'
  exit 0
fi

test_root=$(mktemp -d /tmp/omarchy-drive-dbus-test.XXXXXX)
daemon_pid=""
cleanup() {
  [[ -z $daemon_pid ]] || kill "$daemon_pid" 2>/dev/null || true
  [[ -z $daemon_pid ]] || wait "$daemon_pid" 2>/dev/null || true
  rm -rf -- "$test_root"
}
trap cleanup EXIT

export XDG_STATE_HOME="$test_root/state"
export XDG_CACHE_HOME="$test_root/cache"
export XDG_RUNTIME_DIR="$test_root/runtime"
export OMARCHY_DRIVE_PROVIDER=fake
export OMARCHY_DRIVE_SOCKET="$XDG_RUNTIME_DIR/omarchy-drive.sock"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

(sleep 0.2; exec ./scripts/node-ts.sh daemon/src/main.ts) >"$test_root/daemon.log" 2>&1 &
daemon_pid=$!

dbus-run-session -- bash -eu -o pipefail -c '
  python3 ipc/dbus/omarchy_drive_dbus.py >"$1/dbus.log" 2>&1 &
  bridge_pid=$!
  trap '\''kill "$bridge_pid" 2>/dev/null || true; wait "$bridge_pid" 2>/dev/null || true'\'' EXIT
  for _attempt in {1..100}; do
    if gdbus call --session --dest io.github.placq.OmarchyProtonDrive1 --object-path /io/github/placq/OmarchyProtonDrive1 --method io.github.placq.OmarchyProtonDrive1.GetVersion >"$1/version.out" 2>/dev/null; then break; fi
    kill -0 "$bridge_pid" 2>/dev/null || { sed -n '\''1,120p'\'' "$1/dbus.log" >&2; exit 1; }
    sleep 0.05
  done
  grep -q '\''1.0.0'\'' "$1/version.out"
  gdbus call --session --dest io.github.placq.OmarchyProtonDrive1 --object-path /io/github/placq/OmarchyProtonDrive1 --method io.github.placq.OmarchyProtonDrive1.GetStatus | grep -q '\''"connected": true'\''
  introspect=$(gdbus introspect --session --dest io.github.placq.OmarchyProtonDrive1 --object-path /io/github/placq/OmarchyProtonDrive1)
  for signal in ConflictDetected ConflictResolved AuthRequired; do
    grep -q "$signal(" <<<"$introspect" || { printf '\''Missing D-Bus signal: %s\n'\'' "$signal" >&2; exit 1; }
  done
  ! grep -q '\''watch_reconnect'\'' "$1/dbus.log" || { sed -n '\''1,120p'\'' "$1/dbus.log" >&2; exit 1; }
' _ "$test_root"

printf 'D-Bus runtime integration passed.\n'
