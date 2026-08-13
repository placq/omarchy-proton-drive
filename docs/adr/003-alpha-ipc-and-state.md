# ADR 003: alpha IPC and state persistence

- Status: temporary, revisit before real-account beta
- Verified: 2026-08-13

The daemon uses a user-owned Unix domain socket with versioned newline-delimited JSON and a persistent `Watch` stream for its high-throughput local adapters. It avoids a runtime dependency on an immature Bun D-Bus binding while still giving FUSE one event-driven source of truth. The private socket is mode 0600 and limits requests to 1 MiB.

A small session bridge built on Arch's maintained `python-dbus-next` package owns `io.github.omarchydrive.OmarchyDrive1`. It exposes version/status, pin, evict, retry, transfers and OpenDrive methods, and forwards connection, node, transfer and conflict signals. D-Bus clients never own Drive state; the bridge delegates every operation to the daemon.

The fake-provider alpha stores its small metadata snapshot as an atomically replaced, fsynced, mode-0600 JSON file. Content and unsynced writes are separate. Before real-account beta, migrate metadata, transfer recovery and event cursors to SQLite with WAL and migrations. This substitution must not change `DriveEngine` or `DriveProvider` data-safety rules.

This deviation is not claimed as the final IPC/persistence Definition of Done.
