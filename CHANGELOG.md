# Changelog

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
