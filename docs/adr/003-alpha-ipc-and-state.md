# ADR 003: private IPC and SQLite state persistence

- Status: accepted for 1.0
- Verified: 2026-08-21

The daemon uses a user-owned Unix domain socket with versioned newline-delimited JSON and a persistent `Watch` stream for its high-throughput local adapters. It avoids a runtime dependency on an immature Bun D-Bus binding while still giving FUSE one event-driven source of truth. The private socket is mode 0600 and limits requests to 1 MiB.

A small session bridge built on Arch's maintained `python-dbus-next` package owns `io.github.placq.OmarchyProtonDrive1`. It exposes version/status, pin, evict, retry, transfers and OpenDrive methods, and forwards connection, node, transfer and conflict signals. D-Bus clients never own Drive state; the bridge delegates every operation to the daemon.

Provider-specific metadata, recovery state and event cursors are stored in private SQLite databases with WAL, indexed in-memory lookup and transactional incremental writes. Legacy JSON snapshots migrate atomically on first startup. Content and unsynchronised staging remain separate ordinary private files; corrupt databases are never silently reset, and staging/conflict data is never evicted automatically.

The public desktop contract is the versioned session D-Bus API. The Unix protocol remains private to the packaged adapters and is bounded by request, operation and client timeouts.
