# Test status

Verified 2026-08-14 for `0.2.0-alpha.1`. “Automated” means the fake provider/core suite passes in this repository. Desktop and read-only real-account coverage were exercised on an Omarchy Quattro workstation.

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
| RPC | version/status/core dispatch, real daemon socket, browse/materialize, staged write/commit, restart recovery, Watch transfer events, prompt SIGTERM with an active Watch client | Automated |
| D-Bus/FUSE/Nautilus Python | syntax compilation plus live user service, socket and session D-Bus checks | Passed on Omarchy Quattro with fake provider |
| FUSE runtime | real daemon + pyfuse3 mount, browse/open/write/rename/delete and service restart recovery | Passed on Omarchy Quattro with fake provider; automated test skips only when mount capability is unavailable |
| Shell tooling | syntax validation | Automated |
| Dependency security | production `npm audit` | Automated, 0 known vulnerabilities |
| Real Proton auth/session | official browser login, Secret Service session, root listing and on-demand file download | Passed on Omarchy Quattro; read-only preview |
| Omarchy/Quickshell/Nautilus runtime | installed plugin validation, right-side bar placement, theme-aware icon, account/storage panel, hidden FUSE mount, single sidebar bookmark and clean service recovery | Passed on Omarchy Quattro with a real read-only account |
| Fresh-machine product flow | marketplace install through real upload | Not passed; real writes remain gated |
