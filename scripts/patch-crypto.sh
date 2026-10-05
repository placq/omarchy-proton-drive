#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# @protontech/crypto 2.0.0 ships a source import of "openpgp/lightweight",
# which resolves to a browser-only ESM build; under Node and Bun the daemon
# needs the full build, matching upstream's own patch for the module:
# config/js/patches/@protontech%2Fcrypto@2.0.0.patch in ProtonDriveApps/sdk.
# npm >= 12 applies "patchedDependencies" natively; earlier npm runs this
# script once after `npm ci` (Bun applies it from package.json on its own).
patch="patches/@protontech/crypto@2.0.0.patch"
target="node_modules/@protontech/crypto/src"
if [ -f "$target/pmcrypto/openpgp.ts" ] && grep -q "openpgp/lightweight" "$target/pmcrypto/openpgp.ts"; then
  (cd "$target/pmcrypto" && patch -p3 --forward < "$OLDPWD/patches/@protontech/crypto@2.0.0.patch" >/dev/null)
  echo "Applied $patch."
fi
exit 0
