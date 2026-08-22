# Test status

Automated checks verified 2026-08-22 for the `1.0.0` release tree: the 72-test provider/core suite, 3-test release-gate helper suite, 2-test shared RPC client suite and 7-test pure Nautilus helper suite pass in this repository. Desktop and real-account coverage was last exercised on Omarchy Quattro workstations as recorded below.

| Area | Coverage | Status |
|---|---|---|
| Browse and cached/offline metadata | root children, nested seed, cached fallback | Automated |
| Open | cloud-only, cached, pinned, offline cached, offline cloud-only | Automated |
| Upload | zero-byte, Unicode name, 16 MiB streamed file, network loss | Automated |
| State/restart safety | SQLite transactions, private WAL, legacy migration, corrupt-state refusal, interrupted upload, remote-commit/local-save crash reconciliation and two-phase persistent staging cleanup | Automated |
| Edit/conflict | revision-checked save, remote change/deletion (including a deleted parent tree), preserved conflict copy, crash-safe finalisation, keep-local, keep-remote and save-both | Automated |
| Rename/move/mkdir/trash | native provider operations, descendant-cycle rejection and recursive unsynchronised-data guards | Automated |
| Pin/free space/cache | recursive folder pin, pin refresh, unpin/evict, unsafe eviction, LRU | Automated |
| Concurrency | single-flight download, queued-edit reopen, background commit | Automated |
| Browse performance | incremental SQLite writes, indexed root/child lookup, persisted stale-while-revalidate listings, single-flight provider calls, retained FUSE directory snapshots and prioritized CLI work | Installed warm-cache measurement: root FUSE listing 2.1 ms, 2,809-entry folder 89.8 ms, direct child lookup 0.003 ms in state; one-row SQLite save 0.107 ms median |
| Proton SDK adapter | streamed download/upload and event cursor mapping | Automated with SDK-shaped test client |
| RPC | version/status/core dispatch, real daemon socket, browse/materialize, staged write/commit, restart recovery, Watch transfer events, prompt SIGTERM with an active Watch client | Automated |
| D-Bus/FUSE/Nautilus Python | syntax compilation, extended-attribute status validation and filtering, an isolated real daemon/session-bus bridge test and installed-service checks | Automated; 1,000 FUSE status reads measured 52.0 ms versus 10.38 s for the prior per-file RPC callback simulation |
| FUSE runtime | real daemon + pyfuse3 mount, browse/open/write/rename/move/delete, desktop-style atomic replace, hostile names, Unicode normalisation, link rejection and service restart recovery | Automated with fake provider; the normal-operation matrix also passed with the installed `0.3.0-alpha.2` package against the dedicated real-account directory |
| Shell/tooling/package | syntax validation, staged Arch package layout/import verification, isolated dirty-staging uninstall refusal and checksummed clean-machine harness tamper rejection | Automated |
| Dependency security | production `npm audit` | Automated, 0 known vulnerabilities |
| Real Proton auth/session | official browser login, Secret Service session, root listing, on-demand download and automated expired/revoked error classification | Runtime path passed; manual remote revocation remains a publication gate |
| Omarchy/Quickshell/Nautilus runtime | installed plugin validation/version match, right-side bar placement, theme-aware icon, account/storage panel, hidden FUSE mount, single sidebar bookmark and clean service recovery | Passed on Omarchy Quattro with the writable real-account provider |
| Login/logout recovery UX | stale mount cleanup, retry recovery, animated loading state and no transient integration error during normal startup/logout | Passed on Omarchy Quattro with a real account |
| Fresh-machine product flow | clean-machine install, login, session restore, browse and on-demand open on a second PC | Passed from a checkout; checksummed `1.0.0` release install and `verify-install` passed on 2026-08-22 |
| Real-account write path | isolated `/OmarchyDriveIntegrationTests/`: create, byte-for-byte read/edit, rename, move, pin/unpin, forced remote conflict, save-both and trash cleanup | Passed on 2026-08-15; offline/revoked-session matrix remains a publication gate |

The remaining real-account recovery evidence is collected by `scripts/real_account_recovery.py`. Its local helper/tamper tests pass; the clean-machine release gate is covered by the public artifact runner and the 2026-08-22 acceptance entry above.
