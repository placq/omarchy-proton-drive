# Security model

- The project never accepts a Proton password or receives session tokens over its IPC interfaces.
- The pinned official Proton CLI stores session material through the operating-system secret service; secrets never enter project JSON, SQLite, logs, environment files or process arguments.
- File content, filenames and raw Proton CLI output are not logged. Transfer IDs and node IDs are sufficient for diagnostics.
- Cache, state, staging and conflicts are created with user-only permissions.
- Release-gate evidence is mode `0600` and contains only timestamps, aggregate counts, hashes and scoped fixture IDs; raw journals and account identity are never retained.
- Node IDs used in local paths are allowlisted; names never determine cache/staging paths.
- FUSE uses `default_permissions`; the user services enable `NoNewPrivileges` and system protection.
- Cache is never the only location of dirty content. Eviction, rename, move and recursive trash are denied when the affected tree contains staged, dirty, queued, uploading or conflict data.
- Uploads compare the base revision and never silently overwrite a newer remote revision.

The Unix RPC socket relies on its private runtime-directory ownership and mode `0600`. FUSE validates names at the daemon boundary, including UTF-8 byte limits, lone surrogates and NFC normalisation; symlinks and hard links are explicitly unsupported. The automated hostile-input coverage uses the fake provider, so the equivalent real-account mount matrix remains a publication gate. Real-account writes are enabled only as an alpha feature and remain subject to the dedicated-directory safety rules.
