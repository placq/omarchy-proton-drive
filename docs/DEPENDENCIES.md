# Dependencies

Verified 2026-08-21.

| Dependency | Version / reference | Notes |
|---|---|---|
| Proton Drive SDK | npm `@protontech/drive-sdk` 0.21.0; commit `82c362d0700dc423a51268b074f66037e46ba42a`; published 2026-08-11 | Exact lockfile pin; auth/session explicitly out of scope upstream |
| Omarchy | `quattro` branch | manifest schema 1; `service` and `bar-widget` entry points |
| Quickshell | documentation 0.3.0 | QML plugin frontend |
| GVfs | upstream 1.61.91 source | researched only; rejected for private backend ABI |
| Nautilus | Arch 50.2.2-1 | libnautilus-extension API 4 / nautilus-python |
| FUSE | FUSE3 | chosen filesystem interface |
| Secret Service | Arch `libsecret` / `secret-tool` | explicit package dependency used by the official CLI session store and diagnostics |

The Arch package also declares Bun, GNOME Desktop 4, Nautilus with its Python extension, `python-dbus-next`, `python-pyfuse3` and `python-trio`. The source installer verifies `makepkg`, Git and Bun before building the pinned CLI or changing the installed package.

The npm lockfile records package integrity. Before every SDK update, rerun type checks, unit tests and real-account tests, and review the SDK changelog for event, crypto and upload metadata changes.

The authenticated integration identifies itself with `x-pm-appversion: external-drive-omarchy_drive@1.0.0`; the constant is exported by `ProtonSdkProvider`. It never impersonates a first-party client.

The official CLI's authentication layer is source-available in the SDK monorepo, but it imports `proton-drive-sdk-account` through the local workspace path `file:../incubating/account/js`. That account package is not a published npm dependency, so the code cannot currently be consumed as a normal, independently versioned production dependency. See [AUTH-INTEGRATION.md](AUTH-INTEGRATION.md).
