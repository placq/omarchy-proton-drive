# Development

Run `./scripts/dev-setup.sh`, `npm test`, and `npm run check`. The fake provider starts with `OMARCHY_DRIVE_PROVIDER=fake npm run start:fake`. Its seeded tree contains `Documents/Welcome.txt`.

The daemon's Unix socket defaults to `$XDG_RUNTIME_DIR/omarchy-drive.sock`. Use `omarchy-drive-control status`, `transfers`, `node-status ID`, `pin ID`, `evict ID`, `retry ID`, `sync`, or `watch`.

Real Proton tests must use a dedicated `/OmarchyDriveIntegrationTests/` folder and an interactive secure login. Never place secrets in `.env`, fixtures or CI.
