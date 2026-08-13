# ADR 001: FUSE3 instead of an out-of-tree GVfs backend

- Status: accepted
- Verified: 2026-08-13

## Decision

Use a FUSE3 filesystem plus a Nautilus extension and a persistent GTK bookmark named **Proton Drive**.

## Evidence

GVfs 1.61.91 builds its backends inside the GVfs source tree, links them with internal daemon code and installs backend mount declarations under the package-owned `share/gvfs/mounts` directory. No supported public API or stable third-party backend ABI is documented. Shipping `proton-drive:///` independently would therefore require private headers/ABI or replacement of the system `gvfs` package.

FUSE3 offers a public kernel/userspace contract, is packaged on Arch and lets ordinary applications use normal local filesystem calls. A Nautilus extension supplies Drive-specific actions and emblems. An idempotently managed GTK bookmark supplies the stable sidebar entry when FUSE does not appear as a remote `GVolume`.

## Consequences

The mount is a normal path (`~/Proton Drive`) rather than a custom GIO URI. This is less semantically elegant than a native GVfs remote but is maintainable and does not patch system packages. The daemon remains the only cloud-state owner; the FUSE process is a thin RPC adapter.
