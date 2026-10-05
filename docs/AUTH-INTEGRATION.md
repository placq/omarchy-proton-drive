# Proton authentication integration gate

Verified against the official Proton Drive SDK repository on 2026-08-14.

## What upstream currently provides

- `@protontech/drive-sdk` is published on npm and is already pinned by this project.
- The official CLI constructs `ProtonDriveClient` with an authenticated HTTP client, account/address adapter, SRP implementation, caches and an event cursor provider.
- The CLI stores its session snapshot with `Bun.secrets`, which uses the operating system credential store on Linux.
- Authentication is implemented by `proton-drive-sdk-account`, but the CLI still consumes it as a private monorepo package.
- Proton now ships an official CLI browser-login flow backed by the OS secret store. This project builds that CLI from pinned upstream commit `5491f2eea473acaaa86b5969774b84610a37bd46` and uses it as an isolated authentication/crypto boundary.

Upstream references:

- <https://github.com/ProtonDriveApps/sdk/blob/main/cli/package.json>
- <https://github.com/ProtonDriveApps/sdk/blob/main/cli/src/init.ts>
- <https://github.com/ProtonDriveApps/sdk/blob/main/cli/src/api/index.ts>
- <https://github.com/ProtonDriveApps/sdk/blob/main/cli/src/credentials/secretCredentialsStore.ts>

## Safe implementation criteria

Real-account support may be enabled only when all of the following are true:

1. The account/auth implementation is available as a versioned Proton dependency, or a vendored copy has an explicit license review and an exact upstream commit pin.
2. The login flow supports Proton's current SRP, two-factor and extra-password requirements without logging credentials or accepting them over project IPC.
3. Refresh token, access token, user-key password and cache key are held only in the user's secret service; no secrets enter project SQLite/legacy JSON state, logs, environment files or command arguments.
4. HTTP requests use `x-pm-appversion: external-drive-omarchy_drive@1.0.2` and do not impersonate a first-party client.
5. Logout removes the stored session, stops the provider and leaves dirty/staged local data recoverable.
6. A dedicated Proton test account passes login, session refresh, restart, revoked-session, 2FA, offline and logout tests on Omarchy Quattro.

## Current integration

`OfficialCliProvider` invokes only Proton's official CLI with argument arrays. Passwords and session tokens never cross project IPC or process arguments. Browser login and session refresh stay inside the upstream executable, and credentials remain under service `ch.proton.drive/drive-sdk-cli` in the OS secret store.

The provider uses the official CLI for browsing, downloads and mutations. Edits are guarded by a fresh remote revision check and use the CLI's `create-new-revision` strategy, so a detected remote change is preserved as a local conflict instead of silently replacing the remote file. The CLI owns authentication, cryptography and its internal event cursor; this project emits refresh markers because the CLI does not expose its event stream.


## proton-sdk provider (session reuse, 2026-10-05)

`OMARCHY_DRIVE_PROVIDER=proton-sdk` constructs the SDK client inside the daemon by reusing the session snapshot that this project's official CLI build already maintains in the OS secret service (`ch.proton.drive/drive-sdk-cli`/`auth-session`, including the cache password and the stored user-key password). Criteria status:

1. **Vendored dependency**: satisfied by an exact, unchanged copy of upstream `incubating/account/js` and the CLI's HTTP adapter files at upstream tag `js/v0.21.0`, with the commit recorded in `vendor/*/PROVENANCE.md` and the MIT license text shipped alongside. Upstream published no versioned package yet; the vendored route in these criteria is the one taken.
2. **Login flow**: out of scope by design. The daemon never accepts passwords, never runs SRP against credentials it collected, and reports `AuthenticationRequiredError` until the snapshot exists. Re-authenticate with `proton-drive auth login`; logout is performed through the CLI as well.
3. **Secret handling**: session tokens stay inside the read of the OS secret service; they are never written to project state, logs, IPC payloads or arguments. The daemon writes back rotated tokens to the same snapshot record so the upstream CLI keeps working.
4. **App version**: `x-pm-appversion: external-drive-omarchy_drive@1.0.2` (exported from `ProtonSdkProvider`), plus `x-pm-drive-sdk-version: js@0.21.0`, both identical to the values the official CLI build reports.
5. **Logout**: the daemon does not implement logout; when the snapshot disappears, the provider reports unauthenticated and refuses mutations. A failed token refresh re-reads the snapshot instead of erasing it, so out-of-order refresh contention with the CLI cannot sign the device out by itself.
6. **Dedicated test account**: not yet satisfied for this provider; real-account evidence so far covers browse, create-folder, trash, sync and account status on the maintainer's personal account. Until that account-level matrix (2FA, revoked sessions, offline, logout) is run on a dedicated Proton test account per `docs/TEST-STATUS.md`, keep `proton-cli` as the default (`OMARCHY_DRIVE_PROVIDER=proton-cli` in `~/.config/omarchy-drive/environment`) and treat `proton-sdk` as opt-in and experimental.
