#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

test_root=$(mktemp -d /tmp/omarchy-drive-release-acceptance.XXXXXX)
trap 'rm -rf -- "$test_root"' EXIT
release_dir="$test_root/release"
source_root="$test_root/source/omarchy-drive-1.0.0"
stub_dir="$test_root/bin"
evidence="$test_root/state/clean-machine.json"
mkdir -p "$release_dir" "$source_root" "$stub_dir" "$test_root/home"

tar -czf "$release_dir/omarchy-drive-1.0.0.tar.gz" -C "$test_root/source" omarchy-drive-1.0.0
printf 'pkgver=1.0.0\n' > "$release_dir/PKGBUILD"
cp scripts/clean-machine-acceptance.sh "$release_dir/clean-machine-acceptance.sh"
(cd "$release_dir" && sha256sum omarchy-drive-1.0.0.tar.gz PKGBUILD clean-machine-acceptance.sh > SHA256SUMS)

for tool in omarchy makepkg git bun pacman; do
  printf '#!/usr/bin/env bash\nif [[ $1 == --version ]]; then printf "%s test\\n"; fi\nexit 1\n' "$tool" > "$stub_dir/$tool"
  chmod 755 "$stub_dir/$tool"
done

env HOME="$test_root/home" XDG_STATE_HOME="$test_root/state" PATH="$stub_dir:$PATH" \
  "$release_dir/clean-machine-acceptance.sh" --release-dir "$release_dir" --evidence "$evidence" preflight >/dev/null
[[ -f $evidence && $(stat -c '%a' "$evidence") == 600 ]]
env HOME="$test_root/home" XDG_STATE_HOME="$test_root/state" PATH="$stub_dir:$PATH" \
  "$release_dir/clean-machine-acceptance.sh" --release-dir "$release_dir" --evidence "$evidence" status | grep -q '"complete": false'

printf 'tampered' >> "$release_dir/omarchy-drive-1.0.0.tar.gz"
if env HOME="$test_root/home" XDG_STATE_HOME="$test_root/state" PATH="$stub_dir:$PATH" \
  "$release_dir/clean-machine-acceptance.sh" --release-dir "$release_dir" --evidence "$evidence" status >/dev/null 2>&1; then
  printf 'Tampered release unexpectedly passed checksum verification.\n' >&2
  exit 1
fi
printf 'Clean-machine release harness passed.\n'
