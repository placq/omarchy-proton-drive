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
3. Refresh token, access token, user-key password and cache key are held only in the user's secret service; no secrets enter `state.json`, logs, environment files or command arguments.
4. HTTP requests use `x-pm-appversion: external-drive-omarchy_drive@0.2.0-alpha.1` and do not impersonate a first-party client.
5. Logout removes the stored session, stops the provider and leaves dirty/staged local data recoverable.
6. A dedicated Proton test account passes login, session refresh, restart, revoked-session, 2FA, offline and logout tests on Omarchy Quattro.

## Current integration

`OfficialCliProvider` invokes only Proton's official CLI with argument arrays. Passwords and session tokens never cross project IPC or process arguments. Browser login and session refresh stay inside the upstream executable, and credentials remain under service `ch.proton.drive/drive-sdk-cli` in the OS secret store.

The provider is intentionally read-only. Browsing and downloads are enabled; all cloud mutations return a read-only error and FUSE enforces `EROFS`. `ProtonSdkProvider` remains the future direct integration seam once the account module is published with a stable API or upstream adds conflict-safe revision preconditions to CLI operations.
