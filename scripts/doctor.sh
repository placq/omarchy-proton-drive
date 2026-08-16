#!/usr/bin/env bash
set -u
ok=0; warn=0
check_command() { if command -v "$1" >/dev/null; then printf 'OK   %-24s %s\n' "$1" "$(command -v "$1")"; else printf 'MISS %-24s\n' "$1"; warn=$((warn+1)); fi; }
printf 'Proton Drive for Omarchy doctor\n'
for command in omarchy quickshell nautilus fusermount3 bun python3 gdbus secret-tool omarchy-drive-control; do check_command "$command"; done
mount_dir="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-drive/mount"
if systemctl --user is-active --quiet omarchy-drive.service; then
  for _attempt in {1..20}; do
    [[ -S ${XDG_RUNTIME_DIR:-/tmp}/omarchy-drive.sock ]] && mountpoint -q "$mount_dir" && break
    sleep 0.5
  done
fi
if systemctl --user is-active --quiet omarchy-drive.service; then printf 'OK   daemon service active\n'; else printf 'WARN daemon service inactive\n'; warn=$((warn+1)); fi
if mountpoint -q "$mount_dir"; then printf 'OK   FUSE mount active\n'; else printf 'WARN FUSE mount inactive\n'; warn=$((warn+1)); fi
if [[ -S ${XDG_RUNTIME_DIR:-/tmp}/omarchy-drive.sock ]]; then printf 'OK   daemon socket present\n'; else printf 'WARN daemon socket absent\n'; warn=$((warn+1)); fi
if status_json=$(timeout 15s omarchy-drive-control status 2>/dev/null) && python3 -c '
import json, sys
status=json.load(sys.stdin)
raise SystemExit(0 if status.get("version") == "0.3.0-alpha.2" and status.get("apiVersion") == 1 else 1)
' <<<"$status_json"; then
  printf 'OK   daemon/API version       0.3.0-alpha.2 / 1\n'
else
  printf 'WARN daemon/API version mismatch (expected 0.3.0-alpha.2 / 1)\n'; warn=$((warn+1))
fi
if busctl --user status io.github.placq.OmarchyProtonDrive1 >/dev/null 2>&1; then printf 'OK   session D-Bus active\n'; else printf 'WARN session D-Bus inactive\n'; warn=$((warn+1)); fi
plugin_manifest="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/placq.proton-drive/manifest.json"
if [[ -f $plugin_manifest ]]; then
  if python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1])).get("version") == "0.3.0-alpha.2" else 1)' "$plugin_manifest"; then
    printf 'OK   Quattro plugin version   0.3.0-alpha.2\n'
  else
    printf 'WARN Quattro plugin version mismatch\n'; warn=$((warn+1))
  fi
else printf 'WARN Quattro plugin not installed\n'; warn=$((warn+1)); fi
printf 'Result: %s warning(s)\n' "$warn"
exit "$warn"
