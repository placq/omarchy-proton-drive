# Vendored dependency provenance

`HTTPClient` and `DriveAccountAdapter` come from the official Proton Drive SDK
monorepo CLI at the same pinned commit as `vendor/proton-drive-sdk-account/`
(tag `js/v0.21.0`, commit `e6a661f55b8d7c406de87747b6796891587681e6`, MIT,
`UPSTREAM-LICENSE.md`). Both files are copied unchanged.

They import the account module by the bare package name
`proton-drive-sdk-account`. This repository maps that name to the vendored
sources with the `proton-drive-sdk-account` path alias in `tsconfig.json`, so
neither vendored file requires modification.

`cli/src/api/driveRequirementHook.ts` and `cli/src/cli/*` are not vendored; the
requirement-header hook is reimplemented in `daemon/src/sdk-client.ts` with
identical semantics (`processDriveRequirementHeaders` from the vendored
`apiRequirements.ts`, once per distinct message, to the process stream).
