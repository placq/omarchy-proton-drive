#!/usr/bin/env bash
set -euo pipefail
remove_cache=false
if [[ ${1:-} == --remove-cache ]]; then remove_cache=true; elif [[ ${1:-} != "" ]]; then printf 'Usage: %s [--remove-cache]\n' "$0" >&2; exit 2; fi
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-drive"
shopt -s nullglob
state_files=("$state_dir"/state*.json "$state_dir"/state*.sqlite)
if ((${#state_files[@]})); then
  if ! unsafe=$(python3 - "${state_files[@]}" <<'PY'
import json, sqlite3, sys

unsafe = []
for path in sys.argv[1:]:
    if path.endswith('.sqlite'):
        connection = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        try:
            rows = connection.execute('SELECT json FROM states').fetchall()
            states = [json.loads(row[0]) for row in rows]
        finally:
            connection.close()
    else:
        with open(path, encoding='utf-8') as stream:
            states = json.load(stream).get('states', {}).values()
    unsafe.extend(state for state in states if state.get('status') in {'dirty', 'queued', 'uploading', 'conflict'} or state.get('stagingPath'))
print(len(unsafe))
PY
  ); then
    printf 'Cannot verify local state in %s; refusing unsafe uninstall.\n' "$state_dir" >&2
    exit 2
  fi
  if ((unsafe)); then printf 'Cannot safely remove integration: %s file(s) contain unsynced or conflict data in %s\n' "$unsafe" "$state_dir" >&2; exit 2; fi
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
rm -f -- "${XDG_DATA_HOME:-$HOME/.local/share}/nautilus-python/extensions/omarchy_drive.py" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/nautilus-python/extensions/drive_logic.py"
rmdir --ignore-fail-on-non-empty "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-drive" 2>/dev/null || true
if $remove_cache; then
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-drive"
  if [[ $cache_dir == */omarchy-drive && -d $cache_dir ]]; then rm -rf -- "$cache_dir"; fi
fi
printf 'Integration files, services and sidebar bookmark removed. Persistent state/staging were preserved; remote Proton Drive data was not touched.\n'
printf 'The package can now be removed with: sudo pacman -Rns omarchy-drive\n'
