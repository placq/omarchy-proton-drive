# User flows

- Open cloud-only: FUSE asks the daemon to materialize; the daemon downloads atomically to cache and returns a local path.
- Save: applications write locally; on close FUSE sends the finished content to persistent staging, then the daemon commits a revision.
- Offline save: staging remains intact and changes become queued; reconnect triggers retry.
- Conflict: expected revision mismatch leaves remote untouched and preserves a timestamped local conflict copy.
- Always offline: pin materializes content, persists the flag and protects it from LRU.
- Free local space: unpins and removes only a clean cached copy; unsafe states are rejected.
