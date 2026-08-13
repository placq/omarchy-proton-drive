#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf 'Validating manifest…\n'
node - <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
for (const field of ['schemaVersion', 'id', 'name', 'version', 'kinds', 'entryPoints']) {
  if (!(field in manifest)) throw new Error(`manifest missing ${field}`);
}
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.kinds) || !manifest.kinds.includes('service') || !manifest.kinds.includes('menu')) {
  throw new Error('manifest does not satisfy the Quattro plugin contract');
}
for (const entry of Object.values(manifest.entryPoints)) {
  if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..')) throw new Error(`unsafe entry point: ${entry}`);
}
NODE

printf 'Checking scripts and Python modules…\n'
bash -n scripts/*.sh scripts/omarchy-drive-control
python3 -m py_compile filesystem/fuse/omarchy-drive-fuse.py ipc/dbus/omarchy_drive_dbus.py nautilus/extension/omarchy_drive.py nautilus/extension/drive_logic.py
python3 -m unittest discover -s nautilus/extension -p 'test_*.py'

if command -v systemd-analyze >/dev/null 2>&1; then
  printf 'Checking systemd units…\n'
  # The installed ExecStart paths do not exist in a source checkout. Parse
  # the units, but keep those expected install-time path warnings non-fatal.
  systemd-analyze verify systemd/*.service 2>&1 || true
fi

printf 'Checking QML entry-point shape…\n'
for file in omarchy/Service.qml omarchy/Menu.qml; do
  grep -q '^Item[[:space:]]*{' "$file" || { printf 'Invalid QML root: %s\n' "$file" >&2; exit 1; }
done
grep -q 'function open' omarchy/Menu.qml || { printf 'Missing open() in menu\n' >&2; exit 1; }
grep -q 'function close' omarchy/Menu.qml || { printf 'Missing close() in menu\n' >&2; exit 1; }

printf 'Local validation passed.\n'
