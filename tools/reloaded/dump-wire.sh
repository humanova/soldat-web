#!/bin/sh
# Soldat Reloaded's wire as JSON, for relay/lib/reloaded/: the field tables, unions and enums
# its snapshots are written by, read off its own structs (tools/reloaded/wire-dump). Needs
# Odin and a checkout of https://github.com/soldatreloaded/soldatreloaded:
#
#   tools/reloaded/dump-wire.sh ../soldatreloaded
#
# writes relay/lib/reloaded/wire-<version>.json, and the newest as a module for the page and
# the relay (web/js/spectate/reloaded-wire-data.js, tools/reloaded/wire-js.mjs).
set -e
here=$(cd "$(dirname "$0")" && pwd)
sr=$(cd "${1:?usage: dump-wire.sh <soldatreloaded checkout>}" && pwd)
out=$(mktemp -d)
odin build "$here/wire-dump" -collection:sr="$sr" -out:"$out/wire-dump"
"$out/wire-dump" > "$out/wire.json"
version=$(sed -n 's/^"version": \([0-9]*\),$/\1/p' "$out/wire.json")
mv "$out/wire.json" "$here/../../relay/lib/reloaded/wire-$version.json"
rm -rf "$out"
echo "relay/lib/reloaded/wire-$version.json"
node "$here/wire-js.mjs"
