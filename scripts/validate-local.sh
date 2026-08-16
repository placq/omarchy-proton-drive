#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

printf 'Validating manifest…\n'
node - <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
for (const field of ['schemaVersion', 'id', 'name', 'version', 'kinds', 'entryPoints']) {
  if (!(field in manifest)) throw new Error(`manifest missing ${field}`);
}
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.kinds) || !manifest.kinds.includes('service') || !manifest.kinds.includes('bar-widget')) {
  throw new Error('manifest does not satisfy the Quattro plugin contract');
}
if (typeof manifest.entryPoints.service !== 'string' || typeof manifest.entryPoints.barWidget !== 'string') {
  throw new Error('manifest is missing service or barWidget entry point');
}
if (manifest.version !== pkg.version) throw new Error(`manifest/package version mismatch: ${manifest.version} != ${pkg.version}`);
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error('package-lock version mismatch');
for (const file of ['daemon/src/rpc-server.ts', 'daemon/src/proton-sdk-provider.ts', 'scripts/doctor.sh', 'scripts/install-proton-cli.sh', 'omarchy/Service.qml']) {
  if (!fs.readFileSync(file, 'utf8').includes(pkg.version)) throw new Error(`${file} does not contain package version ${pkg.version}`);
}
const archVersion = pkg.version.replace(/-alpha\./, '_alpha');
if (!fs.readFileSync('packaging/arch/PKGBUILD', 'utf8').includes(`pkgver=${archVersion}`)) throw new Error('PKGBUILD version mismatch');
for (const entry of Object.values(manifest.entryPoints)) {
  if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..')) throw new Error(`unsafe entry point: ${entry}`);
}
NODE

printf 'Checking scripts and Python modules…\n'
bash -n scripts/*.sh
python3 -m py_compile scripts/omarchy-drive-control scripts/real-account-smoke.py filesystem/fuse/omarchy-drive-fuse.py ipc/dbus/omarchy_drive_dbus.py nautilus/extension/omarchy_drive.py nautilus/extension/drive_logic.py
python3 -m unittest discover -s nautilus/extension -p 'test_*.py'
grep -q 'is_local_trash' filesystem/fuse/omarchy-drive-fuse.py || { printf 'FUSE must reject the generic local trash protocol\n' >&2; exit 1; }
./scripts/test-dbus.sh

if command -v systemd-analyze >/dev/null 2>&1; then
  printf 'Checking systemd units…\n'
  # The installed ExecStart paths do not exist in a source checkout. Parse
  # the units, but keep those expected install-time path warnings non-fatal.
  systemd-analyze verify systemd/*.service 2>&1 || true
fi

printf 'Checking QML entry-point shape…\n'
for file in omarchy/Service.qml; do
  grep -q '^Item[[:space:]]*{' "$file" || { printf 'Invalid QML root: %s\n' "$file" >&2; exit 1; }
done
grep -q '^BarWidget[[:space:]]*{' omarchy/BarWidget.qml || { printf 'Invalid bar-widget root\n' >&2; exit 1; }
grep -q 'moduleName: "placq.proton-drive"' omarchy/BarWidget.qml || { printf 'Missing widget module name\n' >&2; exit 1; }

if command -v omarchy >/dev/null 2>&1; then
  printf 'Validating packaged Omarchy plugin…\n'
  plugin_stage="$(mktemp -d)"
  trap 'rm -rf -- "$plugin_stage"' EXIT
  cp -a manifest.json omarchy LICENSE README.md "$plugin_stage/"
  omarchy plugin validate "$plugin_stage"
fi

printf 'Local validation passed.\n'
