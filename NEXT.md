# Next milestone

The next milestone is a complete fake-provider system test on a disposable Omarchy Quattro installation. Real Proton login remains disabled until the desktop stack is proven and the authentication decision gate is passed.

1. Run `./scripts/dev-setup.sh`, `./scripts/install.sh --fake` and `./scripts/doctor.sh` on fresh Quattro.
2. Verify boot recovery, FUSE mount, Nautilus sidebar/actions/emblems and the `placq.proton-drive` Quattro menu.
3. Exercise browse, open, create, edit, move, trash, pin, eviction, offline retry, conflict and unsafe-uninstall scenarios.
4. Record results in `docs/TEST-STATUS.md` and fix every data-safety or startup blocker.
5. Continue with storage hardening and the Proton authentication decision gate described in `docs/ROADMAP.md`.

See [the full development roadmap](docs/ROADMAP.md) for release phases and exit criteria.
