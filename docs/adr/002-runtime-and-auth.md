# ADR 002: TypeScript/Bun daemon and upstream-auth blocker

- Status: accepted
- Verified: 2026-08-13

The daemon uses TypeScript and is packaged for Bun, matching Proton's official CLI stack. Tests also run on Node 24.

The public `@protontech/drive-sdk` 0.21.0 package implements Drive business operations but does not include authentication, session management or the account/address providers required to construct a client. The official CLI source shows those pieces in `proton-drive-sdk-account`, referenced as a monorepo-local `file:../incubating/account/js` package rather than a published npm dependency. Its secret store uses Bun's native secrets API, which maps to the platform credential store.

Therefore this alpha does not implement login. It accepts an already constructed SDK client through a narrow adapter and uses a complete fake provider for local verification. It will not ask for a Proton password, scrape CLI output, shell out to the CLI, copy volatile monorepo internals, or invent an auth protocol. Real login remains blocked until Proton publishes the account package/API or a reviewed vendoring strategy pins the exact upstream source and license.
