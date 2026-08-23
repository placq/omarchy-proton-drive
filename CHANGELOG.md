# Changelog

## 1.0.2 (unreleased)

- Separate cached-content revisions from current remote metadata and invalidate stale or unverifiable cache bytes before they can become an upload base.
- Refuse non-empty FUSE `rmdir`, remove local cache on Proton trash, and prune orphaned cache downloads at startup.
- Refresh the official CLI revision guard immediately before upload and cancel cooperative remote mutations when the RPC deadline or client connection ends.
- Serialize login/logout against all integration CLI users, make the mount path XDG-consistent, redact Nautilus failure details, and harden the FUSE service.
- Audit the complete npm dependency tree instead of excluding the build and test toolchain.
- Render every QML text sink as plain text and bound daemon responses before they reach Quickshell, including per-message and per-watch-process ceilings.
- Keep the FUSE service in the user's mount namespace so its Nautilus mount is visible and permitted.

## 1.0.0

- Promote the synchronized daemon, CLI, package and Quattro manifest version to the first stable semantic version.
- Document the complete native install, update and guarded removal flows required by the Omarchy Plugins marketplace.
- Add marketplace submission metadata, manual-installation guidance and an original trademark-free preview asset.
- Carry forward the data-safety, recovery, IPC, desktop integration and performance hardening completed in the `0.3.0-alpha.2` cycle.

## 0.3.0-alpha.2

- Drop the rotating text-glyph spinner from the cache-clear buttons; the glyph is absent from the bar font and orbited instead of spinning, so the running state is shown by the status line below.
- Remove stale user-directory Nautilus extension copies on install and uninstall so the context menu cannot register twice.
- Show conflicts in the bar popup with keep-local, keep-remote and save-both actions, and notify once per new conflict (without exposing filenames) through the system notifications plugin.
- Report transfer progress honestly: the CLI provider is marked as not progress-capable, so its transfers render as indeterminate instead of a frozen bar, and queued uploads are explicit.
- Allow cancelling a queued or running upload from the bar popup; staged bytes stay recoverable and the node returns to a dirty, re-uploadable state.
- Remove the artificial 2.5 s delay after cache clearing; the completion message appears as soon as the process exits.
- Make the D-Bus conflict surface live: `ConflictResolved` signal added, `Conflict`/`ConflictResolved` events forwarded, and the QML popup scrolls instead of clipping long conflict/transfer lists.
- Replace silent failure swallowing with structured logs (daemon background refreshes, D-Bus reconnects, Nautilus actions) and unify widget language handling; the QML version fallback is now covered by validation.
- Coalesce transfer progress updates to 100 ms while emitting terminal states immediately, bound retained transfer history, and make official CLI timeout/output limits configurable with safe defaults.
- Share one bounded RPC client across FUSE, D-Bus, Nautilus, control and smoke tooling; reject truncated responses instead of spinning on a closed socket.
- Cover hostile FUSE names, NFC normalisation and explicit link rejection; keep post-write size metadata coherent when a concurrent listing races file release.
- Wait for daemon readiness during FUSE startup and suppress expected initial D-Bus reconnect noise so normal login does not restart the mount or pollute the journal.
- Add an isolated regression test proving uninstall refuses dirty staging without deleting its only local bytes.
- Replay pending SQLite changes after a failed transaction so transient storage errors cannot silently drop recovery metadata.
- Catch background commit setup failures without an unhandled rejection; keep exact staging bytes queued and retryable.
- Validate RPC envelope types and return bounded errors for malformed values instead of risking an unhandled server rejection.
- Keep conflict-copy filenames below `NAME_MAX` with UTF-8-safe truncation, hashes and unique suffixes, including for 255-byte remote names.
- Preserve staged bytes when a file or containing tree is deleted remotely; recreate deleted parent folders for keep-local/save-both recovery and prune the retained tree only after explicit keep-remote acceptance.
- Replace staging files atomically after a fully synced temporary copy so a failed large copy cannot truncate the previous recoverable version.
- Support desktop-style atomic file replacement through FUSE, waiting for the temporary upload, retaining a provider-side rollback copy until replacement succeeds and restoring cross-folder sources after a partial failure.
- Declare `libsecret` as a runtime dependency and fail installer preflight early when Git, Bun or makepkg is unavailable.
- Stage the Arch package during local validation and verify runtime entry points while excluding test and bytecode files.
- Recover the upload crash window where Proton committed a revision before SQLite recorded it: compare streamed remote bytes with persistent staging, accept only an exact match, and retain divergent bytes as a conflict.
- Finalise successful uploads in two durable phases so a local database or cleanup failure never removes the only recovery evidence prematurely.
- Add guarded, stateful 1.0 acceptance harnesses for offline-reboot recovery, killed uploads/downloads, real rate-limit recovery, revoked sessions, journal redaction and checksummed clean-machine reinstall evidence.

- Reuse fresh folder metadata before downloads and recursive pinning, cache repeated FUSE directory access, and suppress duplicate Nautilus thumbnail bookkeeping.
- Reuse prepared SQLite statements and remove repeated permission syscalls from the transaction hot path while retaining private database/WAL modes.

## 0.3.0-alpha.1

- Enable real-account create, edit, rename, move and trash operations through the official CLI.
- Guard staged edits with a remote revision check and preserve local conflicts.
- Keep local staging recoverable across offline periods and daemon restarts.
- Migrate metadata and recovery state from JSON to private transactional SQLite with automatic legacy migration.
- Add recursive folder pinning and explicit keep-local, keep-remote and save-both conflict resolution.
- Add versioned daemon/API compatibility checks and bounded IPC/provider operations.
- Return known folder metadata immediately from SQLite, deduplicate concurrent listings and prefetch direct subfolders with bounded concurrency.
- Prevent Nautilus thumbnail generation from materialising cloud-only files and reserve synchronization emblems for real transfer/queued states.
- Limit periodic CLI metadata refresh to the root and pinned trees instead of rescanning every previously visited folder.
- Show explicit cache-clear progress and completion feedback, including bytes intentionally retained for offline files, and perform safe cache eviction without remote metadata round trips.
- Add a separate safe action for removing “Always available” local copies and a panel link that opens the last 24 hours of plugin logs.
- Keep newly written files immediately readable while their background upload is queued or active, without stale FUSE writeback data.
- Block rename, move and recursive trash whenever the affected tree contains staged, queued, uploading or conflicted data.
- Make conflict finalisation crash-safe by persisting the resolved state before removing staging and cache files.
- Classify revoked and expired sessions as authentication-required, redact raw CLI failures and treat rate limiting as retryable.
- Add a real session D-Bus integration test and deterministic release-archive/checksum preparation.
- Build Proton CLI completely before changing the installed package and replace the verified binary atomically.
- Use the popup foreground colour for the logs hyperlink so it remains legible on light and dark themes.
- Open generated logs in the editor selected by Omarchy instead of relying on MIME detection and a browser fallback.
- Match the bar popup and Nautilus actions to the session language (Polish or English), and remove the empty status-message gap above sign out.
- Serialize official CLI commands, disable real-account folder prefetch by default, defer and reduce background refreshes, reject Nautilus' generic `.Trash-*` emulation, route deletions to the native Proton trash, and expose deletion progress in the bar.
- Make SQLite persistence incremental and index roots, children and names in memory instead of repeatedly scanning or rewriting the full cached tree.
- Cache directory handles in FUSE, add direct child lookup, restore CLI paths from SQLite after restart and prioritize clicked operations over queued maintenance work.
- Serve Nautilus status emblems from FUSE metadata instead of opening one daemon connection per visible file, cache account status, and avoid account checks while mounting.
- Keep newly created files locally cached immediately and reuse known metadata during downloads, writes, uploads, renames and moves to eliminate redundant CLI calls.

## 0.2.0-alpha.2

- Recover stale FUSE endpoints automatically across logout, login and service restart.
- Keep Nautilus from crashing the mount while querying extended attributes.
- Show an animated loading state during integration startup and recovery instead of a transient error.
- Clear stale integration errors immediately when login or logout begins.

## 0.2.0-alpha.1

- Added browser-based real-account login through Proton's official CLI with sessions stored in the OS secret service.
- Added read-only browsing and on-demand downloads for real Proton Drive accounts.
- Added the theme-aware Proton bar icon and a native Omarchy account panel with storage, connection, transfer, cache, retry and logout controls.
- Added account identity and Drive quota reporting through a small audited patch applied to a pinned official CLI source commit.
- Kept the real-account filesystem read-only until conflict-safe revision preconditions are available.
- Hid the technical FUSE mount from Nautilus while retaining one persistent **Proton Drive** sidebar bookmark.
- Added safe disposable-cache cleanup, explicit `EROFS` enforcement and real-account provider tests.
- Renamed the product to **Proton Drive for Omarchy** while preserving existing service, package and plugin identifiers.
- Expanded the automated suite to 30 tests and validated the installed integration on Omarchy Quattro.

## 0.1.0-alpha.1

- Added a fake provider and provider-independent Drive engine.
- Added crash-safe staging, offline upload queue, revision conflicts, pinned files and LRU cache eviction.
- Added streaming file-path transfers so large files do not cross IPC as Base64.
- Added FUSE3, Nautilus, Quattro QML and session D-Bus adapters.
- Added systemd user services, local Arch packaging, installer, uninstaller and diagnostics.
- Added the direct Proton Drive SDK adapter and event cursor mapping, while keeping real authentication disabled until its upstream dependency can be integrated safely.
