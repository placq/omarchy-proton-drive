#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=$(node -p 'require("./package.json").version')
tag="v$version"
pkgver=${version/-alpha./_alpha}
if [[ -n $(git status --porcelain) ]]; then
  printf 'Release preparation requires a clean worktree.\n' >&2
  exit 1
fi
if [[ $(git describe --tags --exact-match HEAD 2>/dev/null || true) != "$tag" ]]; then
  printf 'HEAD must have the exact tag %s before preparing a release.\n' "$tag" >&2
  exit 1
fi

release_dir="$PWD/dist/$version"
mkdir -p "$release_dir"
archive="$release_dir/omarchy-drive-$version.tar.gz"
git archive --format=tar --prefix="omarchy-drive-$version/" HEAD | gzip -n -9 > "$archive"
source_sha=$(sha256sum "$archive" | awk '{print $1}')
sed -e "s/@VERSION@/$version/g" -e "s/@PKGVER@/$pkgver/g" -e "s/@SOURCE_SHA256@/$source_sha/g" packaging/arch/PKGBUILD.release.in > "$release_dir/PKGBUILD"
cp CHANGELOG.md LICENSE "$release_dir/"
(cd "$release_dir" && sha256sum "$(basename "$archive")" PKGBUILD > SHA256SUMS)
printf 'Prepared release artifacts in %s\n' "$release_dir"
printf 'Upload the archive, PKGBUILD and SHA256SUMS to the %s release, then build the generated PKGBUILD on a clean machine.\n' "$tag"
