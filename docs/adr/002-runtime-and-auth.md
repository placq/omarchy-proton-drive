# ADR 002: TypeScript/Bun daemon and upstream-auth boundary

- Status: accepted; authentication decision updated 2026-08-14
- Verified: 2026-08-21

The daemon uses TypeScript and is packaged for Bun, matching Proton's official CLI stack. Tests also run on Node 24.

The public `@protontech/drive-sdk` 0.21.0 package implements Drive business operations but does not include authentication, session management or the account/address providers required to construct a client. The official CLI source shows those pieces in `proton-drive-sdk-account`, referenced as a monorepo-local `file:../incubating/account/js` package rather than a published npm dependency. Its secret store uses Bun's native secrets API, which maps to the platform credential store.

The initial alpha therefore did not implement login. The later reviewed decision keeps `ProtonSdkProvider` as a non-production seam and uses a CLI built from the exact pinned official Proton source as the authentication and cryptography boundary. `OfficialCliProvider` invokes it with argument arrays for browser login, session-backed operations and mutations; project code never accepts a Proton password or handles session secrets. The CLI stores its session through the OS secret service. Direct construction of the SDK client remains blocked until Proton publishes the account package as an independently versioned dependency. See `docs/AUTH-INTEGRATION.md` for the pin, criteria and remaining real-account verification gates.
