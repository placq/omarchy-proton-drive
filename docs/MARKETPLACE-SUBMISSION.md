# Marketplace submission draft

Use this body for the [Omarchy Plugins submission form](https://github.com/HANCORE-linux/omarchy-plugin-marketplace/issues/new?template=submit-plugin.yml) after confirming the checklist statements as the repository owner.

### Repository URL

https://github.com/placq/omarchy-proton-drive

### Category

System

### Tags

bar, quickshell, system

### Suggest a missing tag

cloud-storage

### Maintainer notes

This plugin requires native integration in addition to the root Omarchy plugin manifest: an Arch package, Proton's pinned official CLI build, a FUSE adapter, a D-Bus bridge, a Nautilus extension and three systemd user services. The standard `omarchy plugin add` command installs only the QML frontend and is not sufficient. Please apply the `manual-setup` label and review the installer, package-manager, privilege, remote-build and service-management capabilities reported by the marketplace baseline.

The README documents the visible installer prompt, dependencies, update path, guarded removal and the post-install `doctor.sh` check. The public `v1.0.0` release contains the checksummed archive, `PKGBUILD`, `SHA256SUMS` and clean-machine acceptance runner. Real-account testing is restricted to a dedicated account and `/OmarchyDriveIntegrationTests/`; credentials and raw account data are not part of the repository.

### Submission checklist

- [x] The repository is public and contains installation and removal instructions.
- [x] I have documented the plugin license and any external dependencies.
- [x] I confirm that I own or have permission to submit this plugin and its preview assets.
- [x] The plugin does not overwrite user configuration without explicit consent.
- [x] I understand that approval is for listing and is not a security review.
