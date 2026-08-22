# Omarchy Plugins marketplace preparation

This document records the submission metadata and the release checks required before listing Proton Drive for Omarchy on the independent [Omarchy Plugins marketplace](https://omarchyplugins.com/).

## Listing metadata

| Field | Value |
|---|---|
| Repository | `https://github.com/placq/omarchy-proton-drive` |
| Plugin ID | `placq.proton-drive` |
| Name | `Proton Drive for Omarchy` |
| Version | `1.0.0` |
| Category | `System` |
| Tags | `bar`, `quickshell`, `system` |
| Suggested tag | `cloud-storage` |
| License | MIT |
| Preview | root `preview.png`; original generic illustration without third-party marks |

The repository is public, the plugin ID is outside the reserved `omarchy.*` namespace, and the ID was not present in the marketplace registry when checked on 2026-08-22.

## Manual installation requirement

This repository contains one root Omarchy plugin, but the QML entry points depend on a native daemon, FUSE filesystem, D-Bus bridge, Nautilus extension, Arch package and systemd user services. A standard `omarchy plugin add` clone cannot install those components and would leave the widget non-functional.

The submission must therefore ask a marketplace maintainer to apply the `manual-setup` label before `approved-and-verified`. The resulting registry entry must use the curated manual-installation override instead of publishing the standard plugin-add command.

Suggested installation note:

> Requires the native integration. Review the pinned dependencies and run the guarded source installer from a visible terminal by following the repository README. The standard Omarchy plugin-add command installs only the frontend and is not sufficient.

## Expected security-baseline capabilities

The deterministic marketplace scan is expected to require maintainer review for these documented capabilities:

- installer/setup path;
- Arch package management and an interactive privilege boundary;
- a remote source build of Proton's official CLI from a full pinned commit;
- systemd user-service management.

The installer fetches the external CLI source at the full commit `5491f2eea473acaaa86b5969774b84610a37bd46`, verifies the checked-out SHA before applying the repository patch, and builds it in a private temporary directory. It does not use download-to-shell execution, passwordless sudoers rules or privileged process control based on shared temporary state.

These capabilities make `review-required` an expected outcome; they are not by themselves a failed baseline. Any actual finding from the marketplace bot must be resolved or explicitly reviewed under the marketplace policy before publication.

## Release gate

Before submission:

1. Complete every open real-account and clean-machine acceptance item in [NEXT.md](../NEXT.md) using only the dedicated test account and `/OmarchyDriveIntegrationTests/`.
2. Record the resulting evidence in [INSTALLATION-TEST.md](INSTALLATION-TEST.md) and [TEST-STATUS.md](TEST-STATUS.md), without credentials, account identity or filenames.
3. Run `npm ci --ignore-scripts`, `npm test`, `npm run check`, `npm run validate` and `npm audit --omit=dev` from the final tree.
4. Commit the release, create the exact tag `v1.0.0`, then run `./scripts/prepare-release.sh` from the clean tagged commit.
5. Publish the generated archive, PKGBUILD, checksum file and clean-machine runner in the GitHub release; verify the checksums and installation on a clean Omarchy Quattro machine. The public 1.0.0 artifact and the bundled clean-machine runner have now passed this gate.
6. Confirm that the public repository root contains `manifest.json`, `README.md`, `LICENSE` and `preview.png`, with no symlinks in the tracked plugin tree. This repository satisfies that structure.

## Submission draft

Use the marketplace issue form only after the owner has confirmed every checklist statement, including ownership or permission for the code and preview asset.

- Title: `[Plugin]: Proton Drive for Omarchy`
- Repository URL: `https://github.com/placq/omarchy-proton-drive`
- Category: `System`
- Tags: `bar`, `quickshell`, `system`
- Suggest a missing tag: `cloud-storage`
- Maintainer notes: include the manual-installation requirement, the expected reviewed capabilities above and a request for the `manual-setup` label.

Do not open the submission issue until the final release commit is public, all five marketplace checklist statements are true, and the owner explicitly approves the completed issue body.
