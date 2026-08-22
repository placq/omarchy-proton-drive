#!/usr/bin/env bash
set -euo pipefail

output="${HOME}/.local/bin/proton-drive"
if [[ ${1:-} == --output && -n ${2:-} && -z ${3:-} ]]; then
  output=$2
elif [[ -n ${1:-} ]]; then
  printf 'Usage: %s [--output PATH]\n' "$0" >&2
  exit 2
fi

upstream="https://github.com/ProtonDriveApps/sdk.git"
commit="5491f2eea473acaaa86b5969774b84610a37bd46"
project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_dir=$(mktemp -d /tmp/omarchy-proton-cli.XXXXXX)
trap 'rm -rf -- "$build_dir"' EXIT

printf 'Building Proton Drive CLI from verified upstream commit %s…\n' "$commit"
git -C "$build_dir" init -q
git -C "$build_dir" remote add origin "$upstream"
git -C "$build_dir" fetch -q --depth 1 origin "$commit"
git -C "$build_dir" checkout -q --detach FETCH_HEAD
[[ $(git -C "$build_dir" rev-parse HEAD) == "$commit" ]] || { printf 'Upstream commit verification failed.\n' >&2; exit 1; }
git -C "$build_dir" apply "$project_dir/patches/proton-cli-account-info.patch"

(
  cd "$build_dir/cli"
  bun install --frozen-lockfile
  ln -s cli/node_modules "$build_dir/node_modules"
  bun add --no-save @xmldom/xmldom@0.9.10 exifreader@4.39.1
  CLI_APP_VERSION_NAME=external-drive-omarchy_drive \
    CLI_VERSION=1.0.1 JS_VERSION=0.21.0 bun run build
)

install -Dm755 "$build_dir/cli/release/proton-drive" "$output"
printf 'Built %s\n' "$output"
"$output" version
