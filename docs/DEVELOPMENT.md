# Development

Run `./scripts/dev-setup.sh`, `npm test`, and `npm run check`. The fake provider starts with `OMARCHY_DRIVE_PROVIDER=fake npm run start:fake`. Its seeded tree contains `Documents/Welcome.txt`.

The test suite also starts a real daemon subprocess in an isolated XDG workspace. The RPC integration tests cover the Unix socket, browse/materialize, persistent staging, upload commit, restart recovery, and the event-driven `Watch` stream. They do not require Quattro, FUSE, Nautilus, or Proton credentials.

When `python-pyfuse3`, `python-trio` and FUSE mounts are available, `npm test` also runs the FUSE integration test. It starts a disposable mount and exercises normal filesystem operations. In restricted CI or development sandboxes this test is reported as skipped rather than pretending that FUSE was verified.

The daemon's Unix socket defaults to `$XDG_RUNTIME_DIR/omarchy-drive.sock`. Use `omarchy-drive-control status`, `transfers`, `node-status ID`, `pin ID`, `evict ID`, `retry ID`, `sync`, or `watch`.

Real Proton tests must use a dedicated `/OmarchyDriveIntegrationTests/` folder and an interactive secure login. Never place secrets in `.env`, fixtures or CI.
