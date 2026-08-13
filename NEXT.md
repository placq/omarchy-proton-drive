# Next milestone

The project is at the fake-provider desktop MVP, not the real-account MVP.

1. Integrate a Proton-published, reusable browser-auth/session bootstrap or an officially documented equivalent. Store the resulting session only through Bun secrets/libsecret; follow `docs/AUTH-INTEGRATION.md`.
2. Build `ProtonDriveClient` with Proton HTTP, crypto, account, cache, SRP and event dependencies using that authenticated session.
3. Add the SDK event scheduler around the implemented event cursor adapter and extend refresh handling to all owned volumes.
4. Migrate metadata/event/transfer persistence to SQLite; the session D-Bus bridge is implemented and awaits Quattro validation.
5. Run the real-account integration suite in `/OmarchyDriveIntegrationTests/`.
6. Test the FUSE adapter, Nautilus 50.2.2 extension and Quattro QML on a fresh physical/VM Omarchy Quattro installation.
7. Replace the local-development `PKGBUILD` source layout with a signed release tarball after the repository namespace is final.
8. Publish a stable release only after the installation acceptance test in `docs/INSTALLATION-TEST.md` passes without developer commands.
