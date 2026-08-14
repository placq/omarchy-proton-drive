# Next milestone

The next milestone after `0.2.0-alpha.1` is clean-machine acceptance of the read-only real-account preview. Real writes remain disabled until revision-aware conflict safety is available and proven.

1. Reboot the development workstation and verify service, mount, session and panel recovery.
2. Exercise login, logout, re-login, revoked session, offline and reconnect behavior on the dedicated test account.
3. Install the release on a disposable clean Omarchy Quattro system and run `./scripts/doctor.sh`.
4. Verify the single Nautilus bookmark, hidden technical mount, on-demand downloads and safe cache cleanup.
5. Record results in `docs/INSTALLATION-TEST.md` and `docs/TEST-STATUS.md`, then continue storage hardening before real writes.

See [the full development roadmap](docs/ROADMAP.md) for release phases and exit criteria.
