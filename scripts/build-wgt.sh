#!/usr/bin/env bash
# Zip tizen-app/ into dist/TV-Store.wgt. A .wgt is a plain zip with config.xml at the root; the
# package is signed by Apps2Samsung at install time, so nothing here needs the Tizen SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/TV-Store.wgt
( cd tizen-app && zip -r -X -q ../dist/TV-Store.wgt config.xml index.html icon.png js service )
echo "built dist/TV-Store.wgt"
unzip -l dist/TV-Store.wgt
