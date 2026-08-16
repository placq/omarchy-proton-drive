# Session D-Bus API

The stable desktop interface is `io.github.placq.OmarchyProtonDrive1` at `/io/github/placq/OmarchyProtonDrive1`. The numeric suffix is the contract major version. Methods returning structured data return UTF-8 JSON so fields can be added without changing D-Bus signatures.

Methods: `GetVersion`, `GetStatus`, `GetNodeStatus`, `SetPinned`, `Evict`, `Retry`, `ResolveConflict`, `GetTransfers`, `CancelTransfer`, `ClearCache`, `ClearPinnedCache`, and `OpenDrive`.

`ResolveConflict(node_id, resolution, copy_name)` accepts `keep-local`, `keep-remote`, or `save-both`. `copy_name` may be empty to use the generated conflict-copy name.

`CancelTransfer(transfer_id)` cancels a queued or running upload. The node returns to a dirty state with its staged bytes intact; only uploads can be cancelled.

Signals: `ConnectionChanged`, `NodeChanged`, `TransferChanged`, `ConflictDetected`, and `AuthRequired`.

Filesystem operations and bulk data do not cross D-Bus. FUSE uses the private, version-checked Unix transport; applications consume normal filesystem calls through the mounted **Proton Drive** folder.
