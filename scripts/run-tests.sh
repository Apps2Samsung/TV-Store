#!/usr/bin/env bash
# Every test in test/, on the Node that is on PATH: both workflows call this, once per Node version,
# so a new test file runs in CI and before a release without anyone adding it to a list.
set -u
cd "$(dirname "$0")/.."
echo "node $(node --version)"
failed=""
for t in test/run.js test/*.test.js; do
    flags=""
    [ "$t" = test/stream-sign.test.js ] && flags="--expose-gc"   # it measures memory, so it calls gc()
    echo "::group::$t"
    if node $flags "$t"; then echo "::endgroup::"; else echo "::endgroup::"; echo "FAILED $t"; failed="$failed $t"; fi
done
[ -z "$failed" ] || { echo "failed:$failed"; exit 1; }
echo "all tests passed"
