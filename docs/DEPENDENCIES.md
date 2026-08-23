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

The npm lockfile records package integrity. CI runs the full `npm audit`, including development/build dependencies. The official CLI is built from its frozen upstream lockfile at the exact reviewed commit, plus two exact compatibility dependencies. Before every SDK update, rerun type checks, unit tests and real-account tests, review the SDK changelog for event, crypto and upload metadata changes, and review upstream's dependency advisories separately rather than conflating its monorepo build toolchain with this package's npm graph.

As of 2026-08-22, a full `bun audit` of that pinned upstream monorepo reports 51 advisories (29 high, 19 moderate and 3 low) across both build tooling and transitive packages; no critical advisory is reported. Reachability in the compiled CLI has not been established. This is an upstream release-review item, not silently ignored evidence: changing or overriding those packages requires a new Proton source pin, compatibility review and real-account regression run.

The authenticated integration identifies itself with `x-pm-appversion: external-drive-omarchy_drive@1.0.2`; the constant is exported by `ProtonSdkProvider`. It never impersonates a first-party client.

The official CLI's authentication layer is source-available in the SDK monorepo, but it imports `proton-drive-sdk-account` through the local workspace path `file:../incubating/account/js`. That account package is not a published npm dependency, so the code cannot currently be consumed as a normal, independently versioned production dependency. See [AUTH-INTEGRATION.md](AUTH-INTEGRATION.md).
