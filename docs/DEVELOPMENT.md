# Development

Run `npm ci --ignore-scripts`, `./scripts/dev-setup.sh`, `npm test`, and `npm run check`. The fake provider starts with `OMARCHY_DRIVE_PROVIDER=fake npm run start:fake`. Its seeded tree contains `Documents/Welcome.txt`.

The test suite also starts a real daemon subprocess in an isolated XDG workspace. The RPC integration tests cover the Unix socket, browse/materialize, persistent staging, upload commit, restart recovery, and the event-driven `Watch` stream. `scripts/test-dbus.sh` starts the real session bridge under `dbus-run-session` and exercises its version and status methods. Provider tests cover the official CLI write boundary, stale-revision refusal, expired/revoked-session classification and redaction of CLI failures. They do not require Quattro, FUSE, Nautilus, or Proton credentials.

Publication-only recovery tests use `scripts/real_account_recovery.py`; never run its confirmed phases on a personal account. `scripts/clean-machine-acceptance.sh` is copied into the checksummed release directory and refuses preflight when that directory is inside a Git checkout. Both runners separate executable checks from manual login/network/reboot steps and emit anonymized evidence rather than raw account data.

When `python-pyfuse3`, `python-trio` and FUSE mounts are available, `npm test` also runs the FUSE integration test. It starts a disposable mount and exercises normal filesystem operations. In restricted CI or development sandboxes this test is reported as skipped rather than pretending that FUSE was verified.

The daemon's Unix socket defaults to `$XDG_RUNTIME_DIR/omarchy-drive.sock`. Use `omarchy-drive-control status`, `transfers`, `node-status ID`, `pin ID`, `evict ID`, `retry ID`, `sync`, or `watch`.

Advanced runtime tuning is available through the service environment file. CLI commands default to a five-minute timeout and a 64 MiB output limit; override them with `OMARCHY_DRIVE_CLI_TIMEOUT_MS` and `OMARCHY_DRIVE_CLI_MAX_BUFFER_BYTES`. The daemon's cancellation deadline uses `OMARCHY_DRIVE_RPC_TIMEOUT_MS`; FUSE, D-Bus, control and smoke client calls use `OMARCHY_DRIVE_RPC_TIMEOUT_SECONDS`. Both default to five minutes, and disconnecting a client also requests cancellation. Nautilus uses a fixed 250 ms client timeout to avoid blocking the file-manager UI. Invalid or non-positive values safely fall back to the defaults.

Real Proton tests must use a dedicated `/OmarchyDriveIntegrationTests/` folder and an interactive secure login. Never place secrets in `.env`, fixtures or CI.

With an isolated source daemon already running as `proton-cli`, `scripts/real-account-smoke.py --confirm` exercises guarded remote writes only below that folder and trashes its per-run fixture in a `finally` block. It intentionally requires an explicit flag and is never run by CI.

After committing and tagging a clean release as `v<package-version>`, run `scripts/prepare-release.sh`. It creates a deterministic source archive, a release `PKGBUILD` containing the archive checksum, and `SHA256SUMS` under `dist/<version>/`. Upload those exact files to the matching GitHub release and build the generated package on a clean Quattro machine before publication.
