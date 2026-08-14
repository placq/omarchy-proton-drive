#!/usr/bin/env bash
set -euo pipefail

# Node 22 exposed TypeScript execution behind this flag. Newer Node releases
# enable it by default and reject the now-removed option.
node_args=()
if node --help 2>&1 | grep -q -- '--experimental-transform-types'; then
  node_args+=(--experimental-transform-types)
fi

exec node "${node_args[@]}" "$@"
