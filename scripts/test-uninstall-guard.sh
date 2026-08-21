#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

test_root=$(mktemp -d /tmp/omarchy-drive-uninstall-test.XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT
state_dir="$test_root/state/omarchy-drive"
config_dir="$test_root/config/omarchy-drive"
staging_path="$state_dir/staging/precious.bin"
mkdir -p "$state_dir/staging" "$config_dir" "$test_root/bin" "$test_root/home"
printf 'precious staged bytes' > "$staging_path"
printf 'OMARCHY_DRIVE_PROVIDER=fake\n' > "$config_dir/environment"
ln -s /usr/bin/true "$test_root/bin/systemctl"
ln -s /usr/bin/true "$test_root/bin/omarchy"

python3 - "$state_dir/state.sqlite" "$staging_path" <<'PY'
import json
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("CREATE TABLE states (node_id TEXT PRIMARY KEY, json TEXT NOT NULL)")
connection.execute(
    "INSERT INTO states VALUES (?, ?)",
    ("precious", json.dumps({"nodeId": "precious", "status": "queued", "stagingPath": sys.argv[2]})),
)
connection.commit()
connection.close()
PY

set +e
output=$(env \
  HOME="$test_root/home" \
  XDG_STATE_HOME="$test_root/state" \
  XDG_CONFIG_HOME="$test_root/config" \
  XDG_DATA_HOME="$test_root/data" \
  XDG_CACHE_HOME="$test_root/cache" \
  PATH="$test_root/bin:$PATH" \
  ./scripts/uninstall.sh 2>&1)
status=$?
set -e

if ((status != 2)); then
  printf 'Unsafe uninstall returned %s instead of refusing with 2.\n%s\n' "$status" "$output" >&2
  exit 1
fi
grep -q 'Cannot safely remove integration' <<<"$output"
[[ $(<"$staging_path") == 'precious staged bytes' ]]
[[ -f $state_dir/state.sqlite ]]
[[ -f $config_dir/environment ]]
printf 'Unsafe uninstall refusal passed.\n'
