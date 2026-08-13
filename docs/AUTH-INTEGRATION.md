# Proton authentication integration gate

Verified against the official Proton Drive SDK repository on 2026-08-13.

## What upstream currently provides

- `@protontech/drive-sdk` is published on npm and is already pinned by this project.
- The official CLI constructs `ProtonDriveClient` with an authenticated HTTP client, account/address adapter, SRP implementation, caches and an event cursor provider.
- The CLI stores its session snapshot with `Bun.secrets`, which uses the operating system credential store on Linux.
- Authentication is implemented by `proton-drive-sdk-account`, but the CLI depends on it as `file:../incubating/account/js`. It is not a separately published npm package.

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
4. HTTP requests use `x-pm-appversion: external-drive-omarchy_drive@0.1.0-alpha` and do not impersonate a first-party client.
5. Logout removes the stored session, stops the provider and leaves dirty/staged local data recoverable.
6. A dedicated Proton test account passes login, session refresh, restart, revoked-session, 2FA, offline and logout tests on Omarchy Quattro.

## Current integration seam

`ProtonSdkProvider` deliberately accepts an already constructed SDK-compatible client. This keeps filesystem, cache, transfer, event and conflict behavior testable without coupling those layers to an unstable authentication implementation. Once the gate above is satisfied, a bootstrap module can construct the real client and inject it without rewriting the storage engine.
