#!/usr/bin/env bash
# Builds the Soldat WebAssembly client: build/soldat.wasm (copied to web/).
# Run c/build-c.sh first (once) to build the C libraries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cross-compiler installed by tools/setup-fpc.sh
FPCROOT="${FPCROOT:-$HOME/fpc-wasm}"
PPC="${PPC:-$FPCROOT/lib/fpc/3.3.1/ppcrosswasm32}"
SRC="$HERE/src"
OUT="$HERE/build"
OBJ="$HERE/c/obj"
mkdir -p "$OUT/units"

export BUILD_ID="${BUILD_ID:-1.7.1-web}"

"$PPC" @"$FPCROOT/fpc-wasm.cfg" -n \
  -MDelphi -Scgi -O2 -dWEB -dTESTING \
  -ve${VERBOSE:-} \
  -Fu"$SRC/web" -Fu"$SRC/libs" -Fu"$SRC/client" -Fu"$SRC/shared" \
  -Fu"$SRC/shared/network" -Fu"$SRC/shared/mechanics" \
  -Fi"$SRC/shared" -Fi"$SRC/client" \
  -Fo"$OBJ" -Fo"$OBJ/libc" \
  -FU"$OUT/units" -FE"$OUT" \
  -o"$OUT/soldat.wasm" \
  "$SRC/soldatweb.lpr" "$@"
cp "$OUT/soldat.wasm" "$HERE/web/soldat.wasm"
echo "Built web/soldat.wasm"
