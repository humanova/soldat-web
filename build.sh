#!/usr/bin/env bash
# Builds the Soldat WebAssembly clients (copied to web/):
#   ./build.sh            both targets
#   ./build.sh play       the game:      web/soldat.wasm
#   ./build.sh spectate   the spectator: web/soldat-spectate.wasm (-dSPECTATOR, src/spectator)
# Further arguments go to the compiler (e.g. ./build.sh play -B).
# Run c/build-c.sh first (once) to build the C libraries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cross-compiler installed by tools/setup-fpc.sh
FPCROOT="${FPCROOT:-$HOME/fpc-wasm}"
PPC="${PPC:-$FPCROOT/lib/fpc/3.3.1/ppcrosswasm32}"
SRC="$HERE/src"
OBJ="$HERE/c/obj"

export BUILD_ID="${BUILD_ID:-1.7.1-web}"

TARGETS=(play spectate)
case "${1:-}" in
  play|spectate) TARGETS=("$1"); shift ;;
  all) shift ;;
esac

build() {
  local target="$1"; shift
  local out="$HERE/build/$target" program wasm extra=()
  case "$target" in
    play)     program=soldatweb;      wasm=soldat.wasm ;;
    spectate) program=soldatspectate; wasm=soldat-spectate.wasm
              extra=(-dSPECTATOR -Fu"$SRC/spectator" -Fi"$SRC/spectator") ;;
  esac
  # separate unit directories: units compiled with other defines must never be reused
  mkdir -p "$out/units"
  "$PPC" @"$FPCROOT/fpc-wasm.cfg" -n \
    -MDelphi -Scgi -O2 -dWEB -dTESTING ${extra[@]+"${extra[@]}"} \
    -ve${VERBOSE:-} \
    -Fu"$SRC/web" -Fu"$SRC/libs" -Fu"$SRC/client" -Fu"$SRC/shared" \
    -Fu"$SRC/shared/network" -Fu"$SRC/shared/mechanics" \
    -Fi"$SRC/web" -Fi"$SRC/shared" -Fi"$SRC/client" \
    -Fo"$OBJ" -Fo"$OBJ/libc" \
    -FU"$out/units" -FE"$out" \
    -o"$out/$wasm" \
    "$SRC/$program.lpr" "$@"
  cp "$out/$wasm" "$HERE/web/$wasm"
  echo "Built web/$wasm"
}

for t in "${TARGETS[@]}"; do
  build "$t" "$@"
done
