# Installation acceptance test

Status: **installation, reboot, session restore, read path, the isolated real-account write/conflict smoke test and the checksummed 1.0.0 release installation passed; marketplace listing remains pending maintainer review**.

The 77-test automated suite, 14 Python unit tests, live session D-Bus integration, fake-provider FUSE test and real-account read path pass on Omarchy Quattro, including browser login, OS secret storage, Unix socket, FUSE mount, one Nautilus bookmark, account/storage bar panel, on-demand download and service restart recovery. Automated coverage also includes desktop-style atomic replacement, hostile FUSE names and links, non-empty directory deletion refusal, malformed RPC values, failed SQLite transaction replay, remote deletion during local edits, stale-cache invalidation, background-commit setup recovery, ambiguous post-commit crash recovery and unsafe uninstall refusal.

## 2026-08-22 — checksummed 1.0.0 release acceptance

The maintainer ran `scripts/run-clean-machine-release.sh` on a clean Omarchy machine. The run downloaded the public `v1.0.0` assets, verified `SHA256SUMS`, completed `preflight`, installed the package and plugin, then completed both the post-install `doctor.sh` check and `verify-install`. The wrapper reported success and retained the two output logs locally; no account identity, credentials or raw Proton data were added to the repository.

The wrapper does not authenticate an account or create real-account fixtures. Any real-account mutations must remain confined to the dedicated account and `/OmarchyDriveIntegrationTests/`.

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
10. uninstall with dirty staging and verify refusal (automated guard passes; repeat on the installed release package).

## Reproducible 1.0 gate runners

On the dedicated account, run the phases printed by:

```bash
./scripts/real_account_recovery.py --confirm setup
./scripts/real_account_recovery.py status
```

The runner refuses mutations without `--confirm`, verifies every remote ID remains under `/OmarchyDriveIntegrationTests/recovery-*`, proves the offline reboot by a changed kernel `boot_id`, compares fresh remote downloads by SHA-256, and retains no raw journal or account identity. `stage-rate-limit --confirm-rate-limit-observed` must be invoked only after a real, non-induced provider rate-limit condition is present; the runner never hammers Proton to create one. Extra account-specific log needles are read from a private `0600` file via `audit-logs --forbid-file`, never from command-line values.

For the clean machine, copy only `dist/<version>/` (not a checkout), verify/install the artifact following its release instructions, then use its checksummed runner:

```bash
./clean-machine-acceptance.sh preflight
# with the previous checksummed version installed and authenticated:
./clean-machine-acceptance.sh --confirm-dedicated-account snapshot-update
# install the current checksummed artifact
./clean-machine-acceptance.sh --confirm-dedicated-account verify-update
./clean-machine-acceptance.sh verify-install
./clean-machine-acceptance.sh --confirm-dedicated-account snapshot
./clean-machine-acceptance.sh --confirm-dedicated-account verify-uninstall-refusal
# reinstall the same checksummed artifact
./clean-machine-acceptance.sh --confirm-dedicated-account verify-reinstall
./clean-machine-acceptance.sh status
```

The snapshot is anonymized: it stores aggregate counts and digests of node IDs/staging bytes, never account identity or raw file contents. It requires disposable pinned, staged and conflicted fixtures so a vacuous reinstall cannot pass.
