# Architecture

`DriveEngine` owns file state, transfers, cache, staging, conflict decisions and provider calls. `DriveProvider` isolates Proton integration churn; `FakeDriveProvider` exercises the same core without credentials. Real accounts use `OfficialCliProvider`, which keeps Proton authentication and cryptography inside a CLI built from pinned official source. `ProtonSdkProvider` remains a tested direct-SDK seam for a future published authentication package.

The daemon exposes a versioned newline-delimited RPC protocol on a user-only Unix socket. FUSE, the control helper, Nautilus and Quattro consume that protocol. A long-running `Watch` request emits node and transfer changes so UI state is event-driven.

Local layout:

| Data | Location | Evictable |
|---|---|---|
| downloaded content | `$XDG_CACHE_HOME/omarchy-drive/content` | yes, only clean and unpinned |
| metadata/state | `$XDG_STATE_HOME/omarchy-drive/state*.sqlite` (private WAL) | no |
| unsynced writes | `$XDG_STATE_HOME/omarchy-drive/staging` | never automatically |
| conflict copies | `$XDG_STATE_HOME/omarchy-drive/conflicts` | never automatically |

SQLite transactions persist metadata, node state and event cursors; legacy JSON snapshots migrate on first startup. Only changed rows are written, while root, parent/child and child-name indexes stay in memory for constant-time lookup. Writes first land in persistent staging, then upload after a fresh remote revision check. A mismatch preserves local bytes and marks a conflict. Remote deletion, cache eviction and uninstall are blocked while the only unsynchronised copy could be local.

Folder browsing uses stale-while-revalidate metadata: known children return immediately from SQLite, one deduplicated provider refresh runs in the background after a 30-second freshness window, and FUSE retains one immutable listing per open directory handle plus a five-second cross-handle cache. Fresh folder metadata is also reused when opening and recursively pinning files, avoiding a separate CLI metadata process for every node. Direct lookup does not serialize the complete directory. Interactive CLI work takes priority over queued maintenance. Direct-subfolder warming defaults to 12 for SDK/fake providers and 0 for the process-based CLI provider; it uses concurrency 2 when enabled. These defaults can be tuned with `OMARCHY_DRIVE_LISTING_TTL_MS`, `OMARCHY_DRIVE_PREFETCH_FOLDERS`, `OMARCHY_DRIVE_PREFETCH_CONCURRENCY`, `OMARCHY_DRIVE_FUSE_ATTRIBUTE_TTL`, and `OMARCHY_DRIVE_FUSE_DIRECTORY_TTL`.

Nautilus reads node ID and local sync status from FUSE extended attributes. This avoids one Unix-socket round trip per visible file; thumbnail suppression is limited to MIME types for which a thumbnailer is relevant and repeated work is skipped until the URI status or modification time changes.
