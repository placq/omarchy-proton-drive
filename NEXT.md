# Next milestone: 1.0.0 and marketplace publication

Current state: the `1.0.0` release-candidate worktree passes 72 provider/core tests, 12 Python unit tests, the live session D-Bus test, installed-system diagnostics and the isolated real-account create/read/edit/rename/move/pin/conflict/trash smoke test. P1 UX (conflicts in the bar popup, honest CLI progress, upload cancellation, no cache-clear delay hack), P2 hardening (live D-Bus conflict signals, scrollable popup, l10n, error logging), and the planned pre-1.0 process/socket optimisations are implemented in the worktree.

`1.0.0` means: first non-alpha release, published only after every gate below closes. Out of scope (recorded in ROADMAP "Deferred"): multi-account, search, sharing, file history, media streaming, non-Quattro distributions.

## Krok 1 — Close publication gates (testing, no code)

- Real-account recovery matrix (dedicated account, `/OmarchyDriveIntegrationTests/`): offline edit → reboot → reconnect with exact staged bytes; interrupted upload/download → automatic retry without shell restart; revoked/expired session → widget returns to Zaloguj się without stale data; rate limiting → staged data stays recoverable; inspect journal and exported logs for credentials/tokens/filenames.
- Hostile input through the real FUSE mount: invalid UTF-8 boundaries, long names, Unicode normalisation, symlink operations; automate in `fuse-integration.test.ts` where feasible.
- Clean machine: record exact component versions, install from `dist/v1.0.0` artifacts without a source checkout, `doctor.sh` 0 warnings, in-place update, uninstall with dirty staging (refusal), reinstall preserves session/SQLite/pins/staging/conflicts.
- Evidence: `omarchy plugin validate` on the release commit, attached to release notes.

The guarded runners are implemented but do not count as evidence until executed on the target systems: `scripts/real_account_recovery.py` records the real-account matrix without identity or raw logs, while the checksummed release asset `clean-machine-acceptance.sh` records artifact/install/refusal/reinstall evidence on a machine outside any Git checkout.

## Krok 2 — Code hardening before 1.0 (done 2026-08-16)

- D-Bus signal surface alive: `ConflictResolved` added, `Conflict`/`ConflictResolved` forwarded, reconnect failures logged; QML consumes the raw Watch stream (documented in DBUS-API.md).
- `ProtonSdkProvider` stays a tested seam, explicitly unreachable in production (main.ts + ARCHITECTURE.md).
- Dead `readOnly` UI removed from QML; the daemon/FUSE/smoke readOnly guard stays (FUSE write guard and real-account smoke refusal rely on it).
- Error swallowing replaced with logging (engine background refreshes, D-Bus reconnect, Nautilus actions/status, BarWidget clear-cache parse).
- l10n unified in Service.qml; Service.qml version fallback covered by `validate-local.sh`; popup wrapped in a ScrollView so long conflict/transfer lists scroll instead of clipping.

## Krok 3 — Optimisations before 1.0 (done 2026-08-21)

- Transfer progress emissions are coalesced to 100 ms to protect Watch clients, with immediate terminal states.
- CLI `maxBuffer`/timeout are environment tunables; FUSE, D-Bus and control commands use one shared bounded RPC client and timeout setting.
- After 1.0 (research): long-lived CLI process, CLI events instead of polling (`getEvents` stub), parallel uploads.

## Krok 4 — Release 1.0.0

- Done in the worktree: sync `1.0.0` across manifest/package(-lock)/rpc-server/sdk-provider/doctor/install-proton-cli/PKGBUILD/test-dbus/Service.qml; add the changelog and release-candidate README status.
- Tag `v1.0.0` → `./scripts/prepare-release.sh` → upload `dist/1.0.0/*` to the GitHub release → build the generated PKGBUILD on a clean machine.

## Krok 5 — Marketplace submission (manual installation)

- Done in the worktree: README documents native installation, update, guarded removal and external dependencies; license is declared in the manifest; `preview.png` is an original generic illustration without third-party marks.
- Validate the clean release commit and submit via the HANCORE-linux/omarchy-plugin-marketplace issue form: category **System**, tags `bar`, `quickshell`, `system`, and suggested tag `cloud-storage`.
- Maintainer notes must request the `manual-setup` label because the standard `omarchy plugin add` command cannot install the required daemon/package/services; include the expected security-baseline capabilities and the `doctor.sh` post-install check.
- After approval: monitor first reports, keep updates conservative until field evidence (ROADMAP Phase 7).

Useful commands:

```bash
npm test
npm run check
npm run validate
./scripts/doctor.sh
systemctl --user status omarchy-drive.service omarchy-drive-dbus.service omarchy-drive-mount.service
journalctl --user -u omarchy-drive.service -u omarchy-drive-dbus.service -u omarchy-drive-mount.service -b
```
