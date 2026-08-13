# Contributing

This is an unofficial developer alpha. Do not test it with important Proton Drive data.

## Local checks

```bash
npm ci --ignore-scripts
npm test
npm run check
./scripts/validate-local.sh
python3 -m py_compile filesystem/fuse/omarchy-drive-fuse.py ipc/dbus/omarchy_drive_dbus.py nautilus/extension/omarchy_drive.py
bash -n scripts/*.sh scripts/omarchy-drive-control
```

Changes to cache, staging, conflict or eviction behavior must include a regression test proving that unuploaded bytes survive failure. Changes to Proton SDK integration must keep the dependency pinned and document the upstream API/version reviewed.

Real-account changes must satisfy `docs/AUTH-INTEGRATION.md`. Never request Proton credentials in an issue, test fixture, log or command argument.

## Omarchy validation

Use `./scripts/install.sh --fake` only on an Omarchy Quattro test machine or VM, then complete `docs/INSTALLATION-TEST.md`. Include the doctor output and the tested Omarchy/Nautilus/Quickshell versions in the pull request.
