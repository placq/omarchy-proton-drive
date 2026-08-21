# AGENTS.md

Unofficial Proton Drive integration for Omarchy (1.0 release candidate). Multi-language repo: TypeScript daemon, Python FUSE/D-Bus/Nautilus, QML bar widget, bash/systemd/Arch packaging. Docs live in `docs/` (ARCHITECTURE, DBUS-API, AUTH-INTEGRATION, SECURITY, TEST-STATUS) and `NEXT.md`.

## Commands

- `npm ci --ignore-scripts` — always use this, never plain `npm install` (CI does the same)
- `npm test` — Node built-in test runner executing `daemon/tests/*.test.ts` directly via `scripts/node-ts.sh` (adds `--experimental-transform-types` on Node <23). No jest/vitest. Single test: `./scripts/node-ts.sh --test daemon/tests/engine.test.ts`
- `npm run check` — `tsc --noEmit`; covers only `daemon/**/*.ts`, Python/QML/bash are checked by `validate`
- `npm run validate` — full local validation (`scripts/validate-local.sh`); run after any change
- `npm run start:fake` — fake-provider daemon; `OMARCHY_DRIVE_PROVIDER=fake` is required (daemon exits 78 otherwise)
- `./scripts/doctor.sh` — post-install diagnostics
- `./scripts/install.sh --fake` — installs on the machine; ONLY on an Omarchy Quattro test machine/VM, never a dev box
- `./scripts/real-account-smoke.py --confirm` — explicit flag required, never run by CI

## Validation (`npm run validate`)

Enforces: manifest/package/lock/PKGBUILD version sync, `bash -n` on scripts, `py_compile` on all Python, Python unittest (`nautilus/extension/test_*.py`), FUSE local-trash guard, D-Bus runtime test, QML root/module checks, `omarchy plugin validate` when available. `systemd-analyze verify` warnings are non-fatal (install-time paths absent in a checkout).

## Version bumps

`1.0.0` must be synced across: `manifest.json`, `package.json`, `package-lock.json`, `daemon/src/rpc-server.ts`, `daemon/src/proton-sdk-provider.ts`, `scripts/doctor.sh`, `scripts/install-proton-cli.sh`, and `packaging/arch/PKGBUILD` (`-alpha.N` versions use an `_alphaN` separator). `scripts/test-dbus.sh` also greps the version. `validate-local.sh` fails on any mismatch. Release flow: tag `v<package-version>`, then `./scripts/prepare-release.sh` (writes `dist/<version>/`).

## Architecture

- `daemon/src/engine.ts` (`DriveEngine`) owns state, transfers, cache, staging, conflicts; providers plug in behind `DriveProvider` (`provider.ts`)
- Providers: `FakeDriveProvider` (dev/testing), `OfficialCliProvider` (real accounts; auth and crypto live in a CLI built from pinned official source), `ProtonSdkProvider` (seam; `@protontech/drive-sdk` stays pinned)
- Daemon serves a versioned newline-delimited RPC protocol on `$XDG_RUNTIME_DIR/omarchy-drive.sock`; consumers: Python FUSE (`filesystem/fuse/`), D-Bus bridge (`ipc/dbus/`), Nautilus extension (`nautilus/extension/`), QML widget (`omarchy/`)
- State: per-provider SQLite (`state.sqlite` vs `state-<provider>.sqlite`) in `$XDG_STATE_HOME/omarchy-drive/` with legacy-JSON auto-migration; staging and conflicts live there too and are never auto-evicted; content cache in `$XDG_CACHE_HOME/omarchy-drive/` is evictable only when clean and unpinned

## Safety constraints (hard rules)

- Never test with important Proton data; real-account tests only in `/OmarchyDriveIntegrationTests/` on a dedicated account
- Never put Proton credentials in issues, fixtures, logs, or command arguments; real-account changes must satisfy `docs/AUTH-INTEGRATION.md`
- Changes to cache/staging/conflict/eviction MUST include a regression test proving unuploaded bytes survive failure
- Keep `@protontech/drive-sdk` pinned and document the reviewed upstream API/version with any SDK change
- Uninstall/trash/rename/move/evict must keep refusing while unsynced local data is recoverable — preserve that invariant

## Testing quirks

- FUSE integration test auto-skips without `pyfuse3`+`trio`+`fusermount3`
- D-Bus test (`scripts/test-dbus.sh`) auto-skips without `dbus-run-session`/`gdbus`/`dbus_next`; CI forces it with `OMARCHY_DRIVE_REQUIRE_DBUS_TEST=1`
- CI: `npm ci --ignore-scripts && npm test && npm run check && OMARCHY_DRIVE_REQUIRE_DBUS_TEST=1 npm run validate && npm audit --omit=dev`
- Runtime tuning env vars: `OMARCHY_DRIVE_LISTING_TTL_MS`, `OMARCHY_DRIVE_PREFETCH_FOLDERS`, `OMARCHY_DRIVE_PREFETCH_CONCURRENCY`, `OMARCHY_DRIVE_FUSE_ATTRIBUTE_TTL`, `OMARCHY_DRIVE_FUSE_DIRECTORY_TTL`, `OMARCHY_DRIVE_MAINTENANCE_MS`, `OMARCHY_DRIVE_CACHE_BYTES`
