# Development roadmap

This roadmap takes Omarchy Drive from the current fake-provider developer alpha to a safely installable real-account release. Work moves to the next phase only when the previous phase's exit criteria are met.

## Current baseline

- The provider-independent engine, fake provider, persistent staging, cache, conflict protection and background retry logic are implemented.
- FUSE3, Nautilus, Quattro QML, D-Bus and systemd adapters exist but have not run together on Omarchy Quattro.
- The direct Proton Drive SDK adapter streams files and maps event cursors, but no real client can be constructed yet.
- Real login is disabled because the official CLI currently consumes the monorepo-local, unpublished `proton-drive-sdk-account` package.
- Automated baseline: 20 tests, TypeScript typecheck, Python/shell syntax checks and dependency audit pass.

## Phase 1 — Quattro system validation with the fake provider

Goal: prove that the existing components work together on a disposable Omarchy Quattro installation without touching a Proton account.

### 1.1 Fresh-machine preflight

- Install current Omarchy Quattro in a VM or on a test machine.
- Record the Omarchy commit/version and installed Bun, Quickshell, Nautilus, FUSE and Python package versions.
- Clone this repository and run `./scripts/dev-setup.sh`.
- Run `./scripts/install.sh --fake`, followed by `./scripts/doctor.sh`.
- Save doctor output and relevant user-journal logs in the test report; do not commit machine-specific paths or personal data.

### 1.2 Desktop integration

- Confirm all three user services start without manual intervention.
- Confirm `~/Proton Drive` is mounted automatically and appears as **Proton Drive** in the Nautilus sidebar.
- Confirm the `placq.proton-drive` plugin is detected and enabled.
- Open the Quattro menu, verify the fake-provider status and use **Open Proton Drive**.
- Confirm Nautilus emblems and context actions are shown only inside the Drive mount.

### 1.3 Filesystem behavior

- Browse root, nested and empty folders, plus a folder containing many entries.
- Open cloud-only, cached and pinned files.
- Create zero-byte, Unicode, space-containing and large files through Nautilus.
- Edit a file with a normal desktop application, close it and verify the uploaded fake revision.
- Exercise mkdir, rename, cross-folder move and trash.
- Exercise **Always available offline**, **Free local space** and **Retry sync**.

### 1.4 Recovery and safety

- Restart Nautilus, Quickshell and each user service independently.
- Reboot and confirm automatic service and mount recovery.
- Interrupt a write/upload, restart the daemon and verify staging recovery.
- Simulate offline editing and confirm automatic upload after reconnect.
- Simulate a remote revision conflict and verify both copies survive.
- Attempt eviction, trash and uninstall with dirty/queued/conflict data and verify refusal.

### Exit criteria

- Every Phase 1 scenario has a recorded pass/fail result.
- No operation can lose the only copy of unsynchronised data.
- The mount and plugin recover after reboot without developer commands.
- Every discovered defect is fixed or recorded as a blocking GitHub issue.

## Phase 2 — Desktop and storage hardening

Goal: address system-test findings and make the provider-independent layer robust enough for real data.

- Replace JSON metadata/state persistence with an application-owned SQLite schema and atomic migrations; staging content remains ordinary private files.
- Define and test recovery for disk-full, read-only filesystem, corrupt state, missing staging, process kill and interrupted rename cases.
- Add bounded timeouts and cancellation for RPC, D-Bus and provider operations.
- Verify long names, invalid UTF-8 boundaries exposed by FUSE, Unicode normalisation and symlink rejection.
- Add recursive folder pinning with resumable traversal and visible progress.
- Add explicit conflict-resolution operations while preserving the current never-overwrite default.
- Make D-Bus the stable desktop API and document its versioned contract; retain the private Unix protocol as an internal transport only.
- Add runtime integration tests for the Unix socket, D-Bus bridge and a disposable FUSE mount.

### Exit criteria

- State migrations and crash recovery have automated tests.
- The full fake-provider acceptance suite passes repeatedly on Quattro.
- Known failure modes produce actionable UI/status messages and never silently discard data.

## Phase 3 — Proton authentication decision gate

Goal: choose a supportable authentication path before implementing or exposing login.

- Re-check the latest Proton Drive SDK and official CLI at a pinned upstream commit.
- Prefer a Proton-published, versioned account/auth package or documented external-client flow.
- If vendoring is the only viable path, complete a license and security review, pin the exact source commit and isolate the imported code behind `AuthBootstrap`.
- Verify support for current SRP, 2FA, security keys/extra-password requirements, token refresh, revoked sessions and logout.
- Store session secrets only through Bun secrets/libsecret; never in files, SQLite, logs, environment variables or process arguments.
- Write a short ADR with a go/no-go decision. A no-go leaves the fake-provider alpha intact and login hidden.

### Exit criteria

- The selected approach has a documented upstream source, license, versioning and update strategy.
- A dedicated test account can authenticate without the QML plugin collecting a Proton password.
- Secret-store and logout behavior pass a security-focused test checklist.

## Phase 4 — Real Proton client and event engine

Goal: construct `ProtonDriveClient` directly and connect the existing engine to a real account.

- Implement `AuthBootstrap`, secure session restore and explicit disconnect.
- Construct the SDK client with authenticated HTTP, account/address, crypto, SRP, SDK cache and event-cursor dependencies.
- Identify requests as `external-drive-omarchy_drive@<version>-<channel>` without impersonating a first-party client.
- Hydrate owned volume roots once, then process Drive events and cursors without recursive polling.
- Add SDK scheduler integration, bounded concurrency, rate-limit handling and exponential backoff.
- Expose authenticated, expired-session, storage-usage and auth-required states through D-Bus and Quattro.

### Exit criteria

- Login, session restore, refresh, expiration and logout work on the dedicated account.
- List, download, upload, rename, move, trash and events use the SDK directly—never the CLI.
- Revoked or expired sessions fail cleanly without hanging the filesystem or losing staging.

## Phase 5 — Real-account integration and data-safety testing

Goal: validate the complete data path with disposable test data before any personal account use.

- Use only `/OmarchyDriveIntegrationTests/` on a dedicated Proton account.
- Cover small, zero-byte, Unicode and large files; nested/empty/large directories; and cross-folder operations.
- Test open-on-demand, drag-and-drop in both directions, desktop-application save and pinned refresh.
- Test offline edit, daemon crash, reboot, network interruption, rate limiting and remote revision conflicts.
- Test 2FA, session expiry, revoked session, reconnect and logout.
- Clean up remote fixtures and confirm no test data escaped the dedicated directory.

### Exit criteria

- The full matrix in `INSTALLATION-TEST.md` passes.
- No unresolved P0/P1 data-loss, authentication or mount-recovery defects remain.
- Personal Proton accounts are still not recommended until this gate passes on at least one clean Quattro installation.

## Phase 6 — Product packaging and installation

Goal: replace the source-checkout installer with a repeatable end-user installation and update path.

- Build versioned release archives and replace the local-development `PKGBUILD` source layout with a release URL and verified checksum.
- Make **Install integration** perform an explicit, visible package installation followed by service reload/start and health verification.
- Make installation and updates idempotent and preserve the session, pin metadata, staging and conflict copies.
- Add compatibility checks between plugin version, daemon version and IPC API version.
- Add rollback behavior for failed updates.
- Make uninstall offer cache removal separately and refuse removal of unsafe local state.
- Test installation, update and uninstall from a clean Quattro machine with no source checkout.

### Exit criteria

- A user completes install → connect → Files → Proton Drive without developer commands.
- Reinstall/update preserves all safety-critical state.
- The release archive and Arch package are reproducible and their provenance is documented.

## Phase 7 — Alpha release and marketplace submission

Goal: publish an honest, supportable alpha after all safety gates pass.

- Run `omarchy plugin validate` against the release commit.
- Prepare marketplace description and optional preview without Proton trademarks or official visual assets.
- Publish signed release notes with supported versions, known limitations and recovery/uninstall instructions.
- Submit the public repository to Omarchy Plugins only after the fresh-machine acceptance test passes.
- Monitor initial reports and keep automatic updates conservative until mount and data-safety behavior is proven in the field.

## Release targets

| Target | Scope | Gate |
|---|---|---|
| `0.1.0-alpha.2` | Quattro fake-provider validation fixes | Phases 1–2 |
| `0.2.0-alpha.1` | Secure real-account developer preview | Phases 3–5 |
| `0.3.0-alpha.1` | End-user package and update flow | Phase 6 |
| Marketplace alpha | Public discoverability | Phase 7 |

## Deferred until after the first marketplace alpha

- Multi-account support
- Photos-specific views
- Search and shared-with-me UI
- Share-link management
- File history/version UI
- Media streaming optimisations
- Non-Omarchy distributions

## Immediate next session

The next work session should execute Phase 1 on a disposable Omarchy Quattro system. Start with:

```bash
git clone https://github.com/placq/omarchy-proton-drive.git
cd omarchy-proton-drive
./scripts/dev-setup.sh
./scripts/install.sh --fake
./scripts/doctor.sh
```

Do not use a real Proton account during Phase 1. Capture failures with the commands documented in `DEVELOPMENT.md`, fix them in small reviewed pull requests and update `TEST-STATUS.md` after each verified milestone.
