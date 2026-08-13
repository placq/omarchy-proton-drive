# Omarchy Drive

Omarchy Drive is an experimental, unofficial third-party integration for Proton Drive on Omarchy Quattro. It is not affiliated with or supported by Proton AG.

> **Current status: developer alpha.** The local filesystem, cache, offline queue, conflict protection and desktop adapters work against the included fake provider. A real account cannot yet be connected safely because the official CLI's authentication layer depends on the monorepo-local, unpublished `proton-drive-sdk-account` package. The project deliberately does not invent Proton authentication or accept passwords.

## Normal user

The intended product flow is: install from Omarchy Plugins, select **Install integration**, connect the Proton account in a browser, then open **Files → Proton Drive**. That final flow is not released yet. Do not install this alpha expecting access to a real Proton Drive account.

## Developer preview

On Omarchy Quattro:

```bash
./scripts/dev-setup.sh
./scripts/install.sh --fake
```

This installs the native package, enables the fake provider, starts the user services and adds `Proton Drive` to the Nautilus sidebar. It never touches a real account. Run `./scripts/doctor.sh` afterward.

Developer commands:

```bash
npm install
npm test
npm run check
OMARCHY_DRIVE_PROVIDER=fake npm run start:fake
```

See [architecture](docs/ARCHITECTURE.md), [development roadmap](docs/ROADMAP.md), [security model](docs/SECURITY.md), [test status](docs/TEST-STATUS.md), [dependencies](docs/DEPENDENCIES.md), and [next work](NEXT.md).

## What the alpha implements

- direct `@protontech/drive-sdk` dependency behind `ProtonSdkProvider` (no CLI subprocesses);
- fake Drive provider with files, folders, revisions, events, offline failures and conflicts;
- crash-safe persistent staging outside evictable cache;
- cloud-only, cached, pinned, downloading, uploading, dirty, queued, conflict and error states;
- revision-checked uploads and preservation of local conflict copies;
- automatic on-demand downloads, offline queued writes and LRU eviction;
- background event processing, queued-upload retry and configurable 20 GiB default cache limit;
- FUSE3 adapter for browse/open/create/write/mkdir/rename/move/trash;
- Nautilus context actions and status emblems;
- Quattro `service` + `menu` plugin manifest and event stream;
- systemd user services, Arch packaging, safe install/uninstall and diagnostics.

## Data safety

`Free local space`, trash and uninstall refuse to discard `dirty`, `queued`, `uploading` or `conflict` data. Credentials are not stored anywhere in this alpha. Cache lives under `$XDG_CACHE_HOME`; staging and conflict copies live under `$XDG_STATE_HOME` with private permissions.
