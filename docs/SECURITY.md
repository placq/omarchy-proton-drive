# Security model

- The project never accepts a Proton password or receives session tokens over its IPC interfaces.
- The pinned official Proton CLI stores session material through the operating-system secret service; secrets never enter project JSON, SQLite, logs, environment files or process arguments.
- File content and filenames are not logged. Transfer IDs and node IDs are sufficient for diagnostics.
- Cache, state, staging and conflicts are created with user-only permissions.
- Node IDs used in local paths are allowlisted; names never determine cache/staging paths.
- FUSE uses `default_permissions`; the user services enable `NoNewPrivileges` and system protection.
- Cache is never the only location of dirty content. Eviction is denied for dirty, queued, uploading and conflict states.
- Uploads compare the base revision and never silently overwrite a newer remote revision.

Known alpha gaps: the Unix RPC socket does not yet authenticate peers beyond filesystem/session ownership; FUSE and QML have not had a hostile-input audit; real-account writes remain disabled; symlink creation is intentionally unsupported.
