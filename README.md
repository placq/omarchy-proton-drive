# Proton Drive for Omarchy

Proton Drive for Omarchy is an experimental, unofficial third-party integration for Proton Drive on Omarchy Quattro. It is not affiliated with or supported by Proton AG.

> **Current status: developer alpha.** Real-account browser login, browsing, downloads and guarded writes work through Proton's official CLI and OS Secret Service. Edits are checked against the observed remote revision before upload; conflicts preserve the local copy and do not intentionally replace newer remote content.

## Normal user

The intended product flow is deliberately centered on one compact Omarchy bar widget. After installation, the Proton icon appears in the right-hand system area, next to Agents and before Bluetooth.

Clicking the widget opens the Proton Drive status card. There is no separate Omarchy menu entry, application-launcher entry or extra keyboard shortcut for routine access.

The current first-run flow is:

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

## Developer preview

On Omarchy Quattro, use `--fake` for the fully writable development fixture:

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

See [architecture](docs/ARCHITECTURE.md), [D-Bus API](docs/DBUS-API.md), [development roadmap](docs/ROADMAP.md), [security model](docs/SECURITY.md), [test status](docs/TEST-STATUS.md), [dependencies](docs/DEPENDENCIES.md), and [next work](NEXT.md).

## What the alpha implements

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
