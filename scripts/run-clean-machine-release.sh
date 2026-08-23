#!/usr/bin/env bash
set -euo pipefail

# End-to-end release check for a clean Omarchy machine.
# This script deliberately does not authenticate or run real-account tests.

version=${OMARCHY_DRIVE_RELEASE_VERSION:-1.0.2}
repo=${OMARCHY_DRIVE_RELEASE_REPO:-placq/omarchy-proton-drive}
release_dir=${OMARCHY_DRIVE_RELEASE_DIR:-$PWD/omarchy-drive-${version}-release}
tag="v${version}"
archive="omarchy-drive-${version}.tar.gz"
source_dir="${release_dir}/omarchy-drive-${version}"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v gh >/dev/null || die 'Brak programu gh.'
command -v sha256sum >/dev/null || die 'Brak programu sha256sum.'
command -v tar >/dev/null || die 'Brak programu tar.'

if [[ -e $release_dir ]]; then
  [[ -d $release_dir ]] || die "Ścieżka istnieje i nie jest katalogiem: $release_dir"
  [[ -z $(find "$release_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || \
    die "Katalog nie jest pusty: $release_dir (nie usuwam istniejących plików)"
else
  mkdir -p -- "$release_dir"
fi

printf '%s\n' "Pobieram release $tag z $repo do $release_dir"
(
  cd -- "$release_dir"
  gh release download "$tag" \
    --repo "$repo" \
    --pattern "$archive" \
    --pattern PKGBUILD \
    --pattern SHA256SUMS \
    --pattern clean-machine-acceptance.sh
)

[[ -f $release_dir/$archive ]] || die "Nie pobrano $archive"
[[ -f $release_dir/PKGBUILD ]] || die 'Nie pobrano PKGBUILD'
[[ -f $release_dir/SHA256SUMS ]] || die 'Nie pobrano SHA256SUMS'
[[ -f $release_dir/clean-machine-acceptance.sh ]] || die 'Nie pobrano clean-machine-acceptance.sh'

printf '%s\n' 'Sprawdzam SHA256SUMS'
(cd -- "$release_dir" && sha256sum -c SHA256SUMS)

printf '%s\n' 'Uruchamiam preflight'
bash "$release_dir/clean-machine-acceptance.sh" \
  --release-dir "$release_dir" preflight

printf '%s\n' "Rozpakowuję $archive"
tar -xzf "$release_dir/$archive" -C "$release_dir"
[[ -x $source_dir/scripts/install.sh ]] || die "Brak skryptu instalacyjnego w $source_dir"

printf '%s\n' 'Uruchamiam instalację (potwierdź ją, gdy skrypt zapyta)'
(cd -- "$source_dir" && ./scripts/install.sh)

printf '%s\n' 'Uruchamiam doctor.sh po instalacji'
(cd -- "$source_dir" && ./scripts/doctor.sh) | tee "$release_dir/doctor-after-install.txt"

printf '%s\n' 'Uruchamiam verify-install'
bash "$release_dir/clean-machine-acceptance.sh" \
  --release-dir "$release_dir" verify-install | tee "$release_dir/verify-install.txt"

printf '\n%s\n' 'PASS: pobranie, checksumy, preflight, instalacja, doctor.sh i verify-install zakończone.'
printf '%s\n' 'Nie wykonano logowania ani testów realnego konta.'
printf '%s\n' "Wyniki zapisano w: $release_dir/doctor-after-install.txt oraz $release_dir/verify-install.txt"
