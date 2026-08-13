# Architecture

`DriveEngine` owns file state, transfers, cache, staging, conflict decisions and provider calls. `DriveProvider` isolates SDK churn; `FakeDriveProvider` exercises the same core without credentials. `ProtonSdkProvider` maps the public SDK's node and transfer APIs and never invokes the CLI.

The daemon exposes a versioned newline-delimited RPC protocol on a user-only Unix socket. FUSE, the control helper, Nautilus and Quattro consume that protocol. A long-running `Watch` request emits node and transfer changes so UI state is event-driven.

Local layout:

| Data | Location | Evictable |
|---|---|---|
| downloaded content | `$XDG_CACHE_HOME/omarchy-drive/content` | yes, only clean and unpinned |
| metadata/state | `$XDG_STATE_HOME/omarchy-drive/state.json` | no |
| unsynced writes | `$XDG_STATE_HOME/omarchy-drive/staging` | never automatically |
| conflict copies | `$XDG_STATE_HOME/omarchy-drive/conflicts` | never automatically |

State updates are atomically renamed. Writes first land in persistent staging, then upload with an expected remote revision. A mismatch preserves local bytes and marks a conflict. Remote deletion and cache eviction are blocked while the only unsynced copy could be local.
