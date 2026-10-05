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

The official CLI's authentication layer is source-available in the SDK monorepo, but it imports `proton-drive-sdk-account` through the local workspace path `file:../incubating/account/js`. That account package is not a published npm dependency, so it cannot be consumed as a normal, independently versioned production dependency. The `proton-sdk` provider therefore vendors an exact copy of that module plus the CLI's HTTP adapter files at the same pinned commit; see `vendor/proton-drive-sdk-account/PROVENANCE.md` and `vendor/proton-drive-sdk-cli-api/PROVENANCE.md`.

Additional exact npm pins introduced for that provider: `@protontech/crypto` 2.0.0 (commit range of the published tarball; upstream patches it in its own monorepo with the openpgp runtime fix applied here from `patches/@protontech/crypto@2.0.0.patch` via `scripts/patch-crypto.sh`) and `ky` 1.14.3. The vendored module is copied file-for-file at upstream tag `js/v0.21.0` (the same SDK version the root `package.json` pins); before an SDK update, re-review the vendored diff against the new tag, refresh the generated OpenAPI types, and re-run the real-account checks in [AUTH-INTEGRATION.md](AUTH-INTEGRATION.md).
