#!/usr/bin/env bash
# Downloads the data the web pack is built from:
#   <dest>/base  Soldat base repository (CC BY 4.0 assets, 1.8 engine configs)
#   <dest>/app   files of the official Soldat 1.7.1 installer (skip with WITH_171=0)
# Needs git, curl, unzip and innoextract (brew install innoextract).
set -euo pipefail
DEST="${1:-assets-src}"
mkdir -p "$DEST"
cd "$DEST"
if [ ! -d base ]; then
  git clone --depth 1 https://github.com/Soldat/base.git base
fi
if [ "${WITH_171:-1}" = 1 ] && [ ! -d app ]; then
  curl -fL -o soldat1711.zip https://static.soldat.pl/downloads/soldat1711.zip
  unzip -o -q soldat1711.zip
  innoextract -s soldat1711.exe
fi
echo "Assets in $(pwd)"
