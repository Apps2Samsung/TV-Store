#!/usr/bin/env bash
# Zip tizen-app/ into dist/TV-Store.wgt. A .wgt is a plain zip with config.xml at the root; the
# package is signed by Apps2Samsung at install time, so nothing here needs the Tizen SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/TV-Store.wgt
# The service goes in as one bundled file (see scripts/bundle-service.js for why); the modules in
# tizen-app/service/ are its source.
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp -r tizen-app/config.xml tizen-app/index.html tizen-app/icon.png tizen-app/js "$stage"/
mkdir "$stage/service"
node scripts/bundle-service.js "$stage/service/index.js"
( cd "$stage" && zip -r -X -q "$OLDPWD/dist/TV-Store.wgt" config.xml index.html icon.png js service )
echo "built dist/TV-Store.wgt"
unzip -l dist/TV-Store.wgt
