#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fake=false
if [[ ${1:-} == --fake ]]; then fake=true; elif [[ ${1:-} != "" ]]; then printf 'Usage: %s [--fake]\n' "$0" >&2; exit 2; fi
if ! command -v omarchy >/dev/null; then printf 'This product installer requires Omarchy Quattro.\n' >&2; exit 1; fi
if ! command -v makepkg >/dev/null; then printf 'makepkg is required.\n' >&2; exit 1; fi
printf 'Install Omarchy Drive integration?\n\n• background service\n• FUSE filesystem integration\n• Nautilus integration\n\n'
read -r -p 'Continue [y/N]? ' answer
[[ $answer == [yY] ]] || exit 0
(cd packaging/arch && makepkg -si --needed)
plugin_id="placq.proton-drive"
plugin_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/$plugin_id"
mkdir -p "$plugin_dir"
cp -a manifest.json omarchy LICENSE README.md "$plugin_dir/"
mount_dir="$HOME/Proton Drive"; mkdir -p "$mount_dir"
bookmark_file="${XDG_CONFIG_HOME:-$HOME/.config}/gtk-3.0/bookmarks"; mkdir -p "$(dirname "$bookmark_file")"; touch "$bookmark_file"
bookmark_uri="file://${mount_dir// /%20} Proton Drive"
grep -Fqx "$bookmark_uri" "$bookmark_file" || printf '%s\n' "$bookmark_uri" >> "$bookmark_file"
if $fake; then
  env_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-drive"; mkdir -p "$env_dir"; umask 077; printf 'OMARCHY_DRIVE_PROVIDER=fake\n' > "$env_dir/environment"
  systemctl --user daemon-reload; systemctl --user enable --now omarchy-drive.service omarchy-drive-dbus.service omarchy-drive-mount.service
else
  printf '\nNative integration installed but not started. Real Proton authentication is blocked in this alpha; no fake data was enabled.\n'
fi
omarchy-shell shell rescanPlugins || true
omarchy plugin enable "$plugin_id" || true
nautilus -q || true
if $fake; then
  printf 'Verifying installation…\n'
  ./scripts/doctor.sh
fi
printf 'Installation step finished.\n'
