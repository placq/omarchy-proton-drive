#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
missing=()
for command in node npm python3 fusermount3 dbus-run-session; do command -v "$command" >/dev/null || missing+=("$command"); done
if ((${#missing[@]})); then printf 'Missing developer tools: %s\n' "${missing[*]}" >&2; exit 1; fi
env NPM_CONFIG_CACHE="${XDG_CACHE_HOME:-$PWD/.cache}/npm" npm ci --ignore-scripts
npm test
npm run check
printf 'Developer environment is ready. Use scripts/install.sh --fake only on Omarchy Quattro.\n'
