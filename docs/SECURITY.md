# Security model

- The project never accepts a Proton password or receives session tokens over its IPC interfaces.
- The pinned official Proton CLI stores session material through the operating-system secret service; secrets never enter project JSON, SQLite, logs, environment files or process arguments.
- File content, filenames and raw Proton CLI output are not logged. Transfer IDs and node IDs are sufficient for diagnostics.
- Cache, state, staging and conflicts are created with user-only permissions.
- Release-gate evidence is mode `0600` and contains only timestamps, aggregate counts, hashes and scoped fixture IDs; raw journals and account identity are never retained.
- Node IDs used in local paths are allowlisted; names never determine cache/staging paths.
- FUSE uses `default_permissions`; the user services enable `NoNewPrivileges` and system protection.
- Cache is never the only location of dirty content. Eviction, rename, move and recursive trash are denied when the affected tree contains staged, dirty, queued, uploading or conflict data.
- Every cache entry records the exact content revision it contains. Remote metadata refreshes invalidate mismatched clean cache for pinned and unpinned files; unverifiable legacy cache and orphan downloads are removed at startup.
- Uploads compare the edit's base revision in the engine and refresh it again in the official CLI provider after local preparation, immediately before invoking the revision upload. A detected mismatch leaves the remote untouched and preserves staging as a conflict. Proton's CLI does not expose an atomic expected-revision precondition, so real-account writes remain subject to the documented alpha/release gates.

The Unix RPC socket relies on its private runtime-directory ownership and mode `0600`. Bounded RPC mutations receive an abort signal both at their deadline and when the client disconnects; the server waits for cooperative cancellation to settle before reporting a timeout. The shared client rejects an unterminated response above 8 MiB. The control bridge uses a stricter 256 KiB message ceiling for QML and rotates its long-lived watch connection after 16 MiB, enforcing both limits before daemon-controlled bytes reach Quickshell. All explicit bar-widget `Text` sinks force `Text.PlainText`. FUSE validates names at the daemon boundary, including UTF-8 byte limits, lone surrogates and NFC normalisation; symlinks and hard links are explicitly unsupported, and `rmdir` refuses non-empty remote folders. The automated hostile-input coverage uses the fake provider, so the equivalent real-account mount matrix remains a publication gate. Real-account writes are enabled only as an alpha feature and remain subject to the dedicated-directory safety rules.
