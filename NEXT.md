# Next milestone

The `0.3.0-alpha.2` performance/read-write checkpoint passes 55 automated tests, the live session D-Bus test, installed-system diagnostics and the isolated real-account create/read/edit/rename/move/pin/conflict/trash smoke test. Reboot recovery and the clean-machine read flow have passed on two Omarchy Quattro PCs.

## Remaining publication gates

### Real-account recovery matrix

- Edit offline, reboot while queued, reconnect and verify the exact staged bytes upload.
- Interrupt upload and download traffic, then verify automatic retry without restarting the shell.
- Revoke or expire the CLI session and verify the panel returns to **Zaloguj się** without exposing stale account data.
- Exercise rate limiting and confirm queued data remains recoverable.
- Complete the manual Nautilus drag-and-drop and desktop-application save scenarios.
- Inspect the resulting journal and exported log file for credentials, tokens and personal filenames.

Keep every test restricted to `/OmarchyDriveIntegrationTests/` on the dedicated account.

### Release and marketplace evidence

- Record exact Omarchy, Bun, Quickshell, Nautilus, FUSE, Python and package versions for the clean test machine.
- Commit the final tree, create the matching `v0.3.0-alpha.2` tag and run `./scripts/prepare-release.sh`.
- Upload the generated archive, release `PKGBUILD` and `SHA256SUMS`, then build them without a source checkout.
- Verify install, reinstall/update, failed-update recovery and uninstall on a clean Quattro machine.
- Confirm reinstall preserves the Secret Service session, SQLite state, pins, staging and conflicts.
- Confirm uninstall refuses a dirty descendant, removes services/plugin/bookmark and leaves remote data untouched.

### Hardening before marketplace submission

- Complete hostile-input checks for invalid UTF-8 boundaries, long names, Unicode normalisation and unsupported symlink operations through the real FUSE mount.
- Run `omarchy plugin validate` against the release checkout and attach the acceptance evidence to the release.
- Publish supported-version, known-limitation, recovery and uninstall notes.

Useful commands:

```bash
npm test
npm run check
npm run validate
./scripts/doctor.sh
systemctl --user status omarchy-drive.service omarchy-drive-dbus.service omarchy-drive-mount.service
journalctl --user -u omarchy-drive.service -u omarchy-drive-dbus.service -u omarchy-drive-mount.service --since boot
```
