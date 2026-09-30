#!/usr/bin/env bash
# Builds the Free Pascal (trunk) cross-compiler for wasm32-wasip1 used by ../build.sh.
#
#   tools/setup-fpc.sh [PREFIX]        (default PREFIX: ~/fpc-wasm)
#
# Needs a native FPC 3.2.x to bootstrap (macOS: brew install fpc) and git.
# The compiler is patched so its internal wasm linker accepts the
# R_WASM_TABLE_NUMBER_LEB relocations clang emits in the C objects.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${1:-$HOME/fpc-wasm}"
# FPC 3.2's make chokes on long paths: keep the source tree short
SRC="${FPC_SRC:-/tmp/fpc-src}"
COMMIT=bcd728860dcd953cb6f3bbda788eab07b0d16c85
PP="${PP:-$(command -v fpc)}"

if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin https://gitlab.com/freepascal.org/fpc/source.git
fi
git -C "$SRC" fetch -q --depth 1 origin "$COMMIT"
git -C "$SRC" checkout -q -f FETCH_HEAD
git -C "$SRC" apply "$HERE/fpc-ogwasm-table-number-leb.patch"

OPT="-O-"
if [ "$(uname)" = Darwin ]; then
  OPT="$OPT -XR$(xcrun --show-sdk-path)"
fi

cd "$SRC"
make all OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= OPT="$OPT" PP="$PP"
make crossinstall OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= INSTALL_PREFIX="$PREFIX"

UNITS="$PREFIX/lib/fpc/3.3.1/units/wasm32-wasip1"
cat > "$PREFIX/fpc-wasm.cfg" <<CFG
-Twasip1
-Pwasm32
-Fu$UNITS/*
-Fu$UNITS/rtl
-XP
CFG
echo "Installed: $PREFIX/lib/fpc/3.3.1/ppcrosswasm32 (config $PREFIX/fpc-wasm.cfg)"
