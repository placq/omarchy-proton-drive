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
omarchy plugin remove io.github.omarchy-drive || true
printf 'The package can now be removed with: sudo pacman -Rns omarchy-drive\nPersistent state was preserved. Remote Proton Drive data was not touched.\n'
