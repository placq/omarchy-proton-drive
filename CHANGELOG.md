# Changelog

## 0.1.0-alpha.1

- Added a fake provider and provider-independent Drive engine.
- Added crash-safe staging, offline upload queue, revision conflicts, pinned files and LRU cache eviction.
- Added streaming file-path transfers so large files do not cross IPC as Base64.
- Added FUSE3, Nautilus, Quattro QML and session D-Bus adapters.
- Added systemd user services, local Arch packaging, installer, uninstaller and diagnostics.
- Added the direct Proton Drive SDK adapter and event cursor mapping, while keeping real authentication disabled until its upstream dependency can be integrated safely.
