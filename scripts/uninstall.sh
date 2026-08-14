#!/usr/bin/env bash
set -euo pipefail
state_file="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-drive/state.json"
if [[ -f $state_file ]]; then
  unsafe=$(python3 - "$state_file" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); bad=[s for s in d.get('states',{}).values() if s.get('status') in {'dirty','queued','uploading','conflict'}]
print(len(bad))
PY
)
  if ((unsafe)); then printf 'Cannot safely remove integration: %s file(s) contain unsynced or conflict data in %s\n' "$unsafe" "$state_file" >&2; exit 2; fi
fi
systemctl --user disable --now omarchy-drive-mount.service omarchy-drive-dbus.service omarchy-drive.service 2>/dev/null || true
plugin_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/placq.proton-drive"
omarchy plugin remove placq.proton-drive --yes 2>/dev/null || rm -rf -- "$plugin_dir"
bookmark_file="${XDG_CONFIG_HOME:-$HOME/.config}/gtk-3.0/bookmarks"
mount_dir="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-drive/mount"
if [[ -f $bookmark_file ]]; then
  tmp_bookmarks="$(mktemp "${bookmark_file}.XXXXXX")"
  awk -v uri="file://${mount_dir// /%20} Proton Drive" -v legacy="file://${HOME// /%20}/Proton%20Drive Proton Drive" '$0 != uri && $0 != legacy' "$bookmark_file" > "$tmp_bookmarks"
  chmod --reference="$bookmark_file" "$tmp_bookmarks" 2>/dev/null || true
  mv -- "$tmp_bookmarks" "$bookmark_file"
fi
rm -f -- "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-drive/environment"
rmdir --ignore-fail-on-non-empty "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-drive" 2>/dev/null || true
printf 'Integration files, services and sidebar bookmark removed. Persistent state/staging were preserved; remote Proton Drive data was not touched.\n'
printf 'The package can now be removed with: sudo pacman -Rns omarchy-drive\n'
