# Installation acceptance test

Status: **installation, reboot, session restore, read path and the isolated real-account write/conflict smoke test passed; offline-reboot-reconnect, revoked-session and marketplace-release installation remain publication gates**.

The 48-test automated suite, live session D-Bus integration, fake-provider desktop test and real-account read path pass on Omarchy Quattro, including browser login, OS secret storage, Unix socket, FUSE mount, one Nautilus bookmark, account/storage bar panel, on-demand download and service restart recovery. Marketplace installation from a published release artifact is not yet claimed.

## 2026-08-15 — reboot acceptance

Passed on the current Omarchy Quattro workstation after a full reboot. The daemon, session D-Bus bridge and FUSE mount recovered automatically; `./scripts/doctor.sh` returned 0 warnings. The Proton bar widget, account/session state, single Nautilus **Proton Drive** bookmark and on-demand cloud-only file opening were verified manually. The account lifecycle and recovery checks were also completed without a restart of the shell.

## Clean-machine acceptance — second PC

Passed on a second PC. The `0.3.0-alpha.1` read/write installation, login/session restore, file browsing and on-demand opening flow were verified successfully. Exact machine and component versions are not recorded in this report.

## 2026-08-15 — isolated real-account write smoke test

Passed against a signed-in real account, with every mutation confined to `/OmarchyDriveIntegrationTests/smoke-<timestamp>/` and the run folder trashed automatically afterward. Verified create, byte-for-byte upload/download, edit as a new revision, rename, nested-folder move, pin/unpin, an externally forced remote revision conflict, `save-both` preservation of the exact local bytes, and cleanup. The reusable guarded runner is `scripts/real-account-smoke.py --confirm`.

The built Arch package was then upgraded in place from `0.2.0_alpha1-2` to the tested `0.3.0_alpha1-5` package revision. Legacy JSON state migrated to private SQLite/WAL, all three user services restarted cleanly, the plugin manifest was upgraded to `0.3.0-alpha.1`, and `doctor.sh` returned 0 warnings including daemon/API/plugin compatibility. A second fixture exercised create/write/read/rename/move/trash through the installed FUSE mount and was removed successfully. Later local `pkgrel` values have not been separately claimed by this historical entry.

Release gate:

1. fresh Omarchy Quattro with no source checkout;
2. install the plugin from marketplace and the native package from the matching checksummed release;
3. verify native installation health with `scripts/doctor.sh`;
4. complete browser login and 2FA/security key;
5. verify sidebar entry after reboot;
6. browse and open a real cloud-only file;
7. drag a file into Drive and verify remote content through Nautilus (the automated equivalent has passed through the same daemon write path);
8. edit offline, reboot, reconnect and verify upload;
9. ~~force a remote revision conflict and verify both copies;~~ passed with exact local-byte verification;
10. uninstall with dirty staging and verify refusal.
