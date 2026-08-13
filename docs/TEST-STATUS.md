# Test status

Verified 2026-08-13. “Automated” means the fake provider/core suite passes in this repository. Desktop and real-account rows require an Omarchy Quattro machine.

| Area | Coverage | Status |
|---|---|---|
| Browse and cached/offline metadata | root children, nested seed, cached fallback | Automated |
| Open | cloud-only, cached, pinned, offline cached, offline cloud-only | Automated |
| Upload | zero-byte, Unicode name, 16 MiB streamed file, network loss | Automated |
| Restart safety | interrupted upload and persistent staging recovery | Automated |
| Edit/conflict | revision-checked save, remote change, preserved conflict copy | Automated |
| Rename/move/mkdir/trash | native provider operations and unsafe-trash guard | Automated |
| Pin/free space/cache | pin refresh, unpin/evict, unsafe eviction, LRU | Automated |
| Concurrency | single-flight download, queued-edit reopen, background commit | Automated |
| Proton SDK adapter | streamed download/upload and event cursor mapping | Automated with SDK-shaped test client |
| RPC | version/status/core dispatch | Automated in process; socket bind blocked by build sandbox |
| D-Bus/FUSE/Nautilus Python | syntax compilation | Automated; runtime pending Omarchy |
| Shell tooling | syntax validation | Automated |
| Dependency security | production `npm audit` | Automated, 0 known vulnerabilities |
| Real Proton auth/session | upstream integration gate documented | Blocked by unpublished account package |
| Omarchy/Quickshell/Nautilus runtime | install, boot, mount, sidebar, QML behavior | Not run; requires Omarchy Quattro |
| Fresh-machine product flow | marketplace install through real upload | Not passed |
