#!/usr/bin/env bash
set -u
ok=0; warn=0
check_command() { if command -v "$1" >/dev/null; then printf 'OK   %-24s %s\n' "$1" "$(command -v "$1")"; else printf 'MISS %-24s\n' "$1"; warn=$((warn+1)); fi; }
printf 'Omarchy Drive doctor\n'
for command in omarchy quickshell nautilus fusermount3 bun python3 gdbus secret-tool omarchy-drive-control; do check_command "$command"; done
if systemctl --user is-active --quiet omarchy-drive.service; then printf 'OK   daemon service active\n'; else printf 'WARN daemon service inactive\n'; warn=$((warn+1)); fi
if mountpoint -q "$HOME/Proton Drive"; then printf 'OK   FUSE mount active\n'; else printf 'WARN FUSE mount inactive\n'; warn=$((warn+1)); fi
if [[ -S ${XDG_RUNTIME_DIR:-/tmp}/omarchy-drive.sock ]]; then printf 'OK   daemon socket present\n'; else printf 'WARN daemon socket absent\n'; warn=$((warn+1)); fi
if busctl --user status io.github.omarchydrive.OmarchyDrive1 >/dev/null 2>&1; then printf 'OK   session D-Bus active\n'; else printf 'WARN session D-Bus inactive\n'; warn=$((warn+1)); fi
if [[ -f ${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/io.github.omarchy-drive/manifest.json ]]; then printf 'OK   Quattro plugin installed\n'; else printf 'WARN Quattro plugin not installed\n'; warn=$((warn+1)); fi
printf 'Result: %s warning(s)\n' "$warn"
exit "$warn"
