# Proton Drive for Omarchy

Proton Drive for Omarchy is an unofficial third-party integration for Proton Drive on Omarchy Quattro. It is not affiliated with, supported by or endorsed by Proton AG or the Omarchy project.

> **Current status: 1.0.0 release candidate.** The source and marketplace metadata are prepared for the first stable release. Publication still depends on the release-acceptance evidence tracked in [NEXT.md](NEXT.md) and [the installation test](docs/INSTALLATION-TEST.md). Do not use an unpublished build with important Proton Drive data.

## Requirements

- Omarchy Quattro on Arch Linux;
- a dedicated Proton account for pre-release testing;
- Git, Bun and `makepkg` for source installation;
- the runtime dependencies declared by the Arch package: FUSE3, GNOME Desktop 4, libsecret, Nautilus and nautilus-python, python-dbus-next, python-pyfuse3 and python-trio.

The installer builds the authentication boundary from a pinned commit of Proton's official Drive CLI source. Exact source references and package versions are documented in [Dependencies](docs/DEPENDENCIES.md). Proton credentials are entered only in Proton's browser flow and are stored by the operating-system Secret Service.

## Install

This integration needs a native daemon, FUSE adapter, D-Bus bridge, Nautilus extension and user services. The standard `omarchy plugin add` command installs only the QML frontend and is therefore **not** a complete installation path. The marketplace listing must use its manual-installation mode.

Review the source, then run the installer from a visible terminal so `makepkg` can request administrator authentication:

```bash
git clone https://github.com/placq/omarchy-proton-drive.git
cd omarchy-proton-drive
./scripts/install.sh
```

The installer shows its scope before making changes. It builds the pinned official CLI in a temporary directory, installs the `omarchy-drive` Arch package, copies the user-owned shell plugin to `~/.config/omarchy/plugins/placq.proton-drive`, adds one Nautilus bookmark and enables three systemd user services. Verify the result with:

```bash
./scripts/doctor.sh
```

## Update

Update only from a reviewed release or commit, then rerun the same installer:

```bash
git pull --ff-only
./scripts/install.sh
./scripts/doctor.sh
```

The installer preserves the private SQLite state, persistent staging and conflict copies.

## Remove

Run the guarded uninstaller from the repository checkout:

```bash
./scripts/uninstall.sh
sudo pacman -Rns omarchy-drive
```

The uninstaller refuses to continue while unsynchronised or conflicted local bytes remain recoverable. It disables the services and removes the shell plugin and sidebar bookmark, but preserves persistent state/staging and never deletes remote Proton Drive data. To remove only disposable cache after the safety check, use `./scripts/uninstall.sh --remove-cache`.

Do not use only `omarchy plugin remove placq.proton-drive`: that removes the QML frontend but leaves the native integration installed.

## Usage

The product flow is centered on one compact Omarchy bar widget. After installation, the Proton icon appears in the right-hand system area, next to Agents and before Bluetooth.

Clicking the widget opens the Proton Drive status card. There is no separate Omarchy menu entry, application-launcher entry or extra keyboard shortcut for routine access.

The first-run flow is:

1. Install the plugin and native integration.
2. Click the Proton icon on the right side of the bar.
3. Click **Zaloguj się** in the panel and complete Proton authentication in the browser.
4. Return to Omarchy after authentication succeeds.
5. Return to the bar and see the active Proton icon.

The widget uses these status indicators:

| Bar indicator | Meaning |
|---|---|
| Dim Proton icon | Account is not configured |
| Alert-colored Proton icon | Sign-in or integration requires attention |
| Proton icon | Connected and ready |
| Proton icon with a status dot | Transfer or synchronization is active |

The status card shows account identity, remote storage usage, connection state, transfers and safe local-cache controls. Proton Drive remains available as a single Nautilus sidebar bookmark. Real cloud files can be browsed, opened, created, edited, moved, renamed and trashed. Offline edits remain staged locally and are retried after reconnect; a changed remote revision creates a preserved local conflict copy.

## Development

On an Omarchy Quattro test machine or VM, use `--fake` for the fully writable development fixture:

```bash
./scripts/dev-setup.sh
./scripts/install.sh --fake
```

This installs the native package, enables the fake provider, starts the user services and adds `Proton Drive` to the Nautilus sidebar. It never touches a real account. Run `./scripts/doctor.sh` afterward.

Developer commands:

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run validate
OMARCHY_DRIVE_PROVIDER=fake npm run start:fake
```

See [architecture](docs/ARCHITECTURE.md), [D-Bus API](docs/DBUS-API.md), [development roadmap](docs/ROADMAP.md), [security model](docs/SECURITY.md), [test status](docs/TEST-STATUS.md), [dependencies](docs/DEPENDENCIES.md), [marketplace preparation](docs/MARKETPLACE.md), and [next work](NEXT.md).

The guarded release-gate runners are `scripts/real_account_recovery.py` for the dedicated Proton account and `scripts/clean-machine-acceptance.sh` for a checksummed artifact on a clean Quattro machine. Their presence is not itself a passed release gate; acceptance requires the target-machine evidence described in `docs/INSTALLATION-TEST.md`.

## What 1.0 implements

- direct `@protontech/drive-sdk` dependency behind the future `ProtonSdkProvider` integration seam;
- real-account provider using Proton's official browser-authenticated CLI as the session and cryptography boundary;
- fake Drive provider with files, folders, revisions, events, offline failures and conflicts;
- crash-safe persistent staging outside evictable cache;
- private transactional SQLite state with automatic migration from legacy JSON;
- cloud-only, cached, pinned, downloading, uploading, dirty, queued, conflict and error states;
- revision-checked uploads and preservation of local conflict copies;
- recursive folder pinning and keep-local, keep-remote or save-both conflict resolution;
- automatic on-demand downloads, offline queued writes and LRU eviction;
- background event processing, queued-upload retry and configurable 20 GiB default cache limit;
- FUSE3 adapter for browse/open/create/write/mkdir/rename/move/trash;
- Nautilus context actions and status emblems;
- Quattro `service` + `bar-widget` plugin manifest and event stream;
- compact, theme-aware Proton icon in the right-hand bar section as the sole Omarchy entry point;
- systemd user services, Arch packaging, safe install/uninstall and diagnostics.

## Data safety

`Free local space`, rename, move, trash and uninstall refuse unsafe operations while a node or folder descendant has recoverable staged data. Proton credentials and raw CLI output never enter project state or logs; the official CLI stores its session in the operating-system secret service. Cache lives under `$XDG_CACHE_HOME`; staging and conflict copies live under `$XDG_STATE_HOME` with private permissions.

## License

[MIT](LICENSE). Proton and Proton Drive are trademarks of Proton AG; they are referenced only to describe interoperability. The generated marketplace preview is an original generic illustration and contains no Proton or Omarchy marks.
