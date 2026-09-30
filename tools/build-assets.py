#!/usr/bin/env python3
"""Builds the browser client's game data.

  web/soldat.smod        core archive (stored zip): graphics, sounds, animations, maps, configs
  web/assets/...         map textures and scenery, fetched on demand by the client
  web/assets/index.json  list of the files under web/assets
  web/play-regular.ttf   interface font

Soldat 1.7.1 files take precedence (they match what the servers run); the CC BY 4.0
"base" repository supplies files the engine expects that 1.7.1 does not ship
(configs, weather sounds, a few interface images).

usage: build-assets.py --base <soldat-base checkout> [--v171 <1.7.1 game dir>] --out <web dir>

Without --v171 the pack only contains the CC BY 4.0 base assets (safe to redistribute);
graphics a map needs that are missing are then downloaded from the game server.
"""
import argparse
import json
import os
import shutil
import sys
import zipfile

CORE_DIRS = ['anims', 'custom-interfaces', 'gostek-gfx', 'interface-gfx', 'maps', 'objects',
             'objects-gfx', 'sfx', 'sparks-gfx', 'txt', 'weapons-gfx']
CORE_TEXTURE_DIRS = ['textures/objects', 'textures/edges']
ON_DEMAND_DIRS = ['textures', 'scenery-gfx']
SKIP_PARTS = {'modules'}          # sfx/modules/*.xm (tracker music the engine cannot play)
SKIP_EXT = {'.db', '.exe', '.dll'}


def collect(root, rel_dir):
    out = {}
    base = os.path.join(root, rel_dir)
    if not os.path.isdir(base):
        return out
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d.lower() not in SKIP_PARTS]
        for f in fn:
            if os.path.splitext(f)[1].lower() in SKIP_EXT or f.startswith('.'):
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            out[rel.lower()] = (rel, full)
    return out


def merged(sources, rel_dir):
    """Later sources win; keys are lower-case paths."""
    files = {}
    for root in sources:
        for k, v in collect(root, rel_dir).items():
            files[k] = v
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True, help='soldat base repository (shared/ and client/ inside)')
    ap.add_argument('--v171', help='Soldat 1.7.1 game directory (its files take precedence)')
    ap.add_argument('--out', required=True, help='web directory')
    a = ap.parse_args()

    base_shared = os.path.join(a.base, 'shared')
    sources = [base_shared] + ([a.v171] if a.v171 else [])
    os.makedirs(a.out, exist_ok=True)

    core = {}
    for d in CORE_DIRS:
        core.update(merged(sources, d))
    for d in CORE_TEXTURE_DIRS:
        core.update(merged(sources, d))
    for name in ['mod.ini']:
        for root in sources:
            p = os.path.join(root, name)
            if os.path.isfile(p):
                core[name] = (name, p)
    # client configuration defaults (1.8 engine format)
    cfg_dir = os.path.join(a.base, 'client', 'configs')
    for f in sorted(os.listdir(cfg_dir)):
        core['configs/' + f.lower()] = ('configs/' + f, os.path.join(cfg_dir, f))
    extra_cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'configs')
    if os.path.isdir(extra_cfg):
        for f in sorted(os.listdir(extra_cfg)):
            core['configs/' + f.lower()] = ('configs/' + f, os.path.join(extra_cfg, f))

    smod = os.path.join(a.out, 'soldat.smod')
    tmp = smod + '.tmp'
    total = 0
    with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_STORED) as z:
        for key in sorted(core):
            rel, full = core[key]
            info = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            with open(full, 'rb') as fh:
                data = fh.read()
            total += len(data)
            z.writestr(info, data)
    os.replace(tmp, smod)
    print(f'soldat.smod: {len(core)} files, {total / 1048576:.1f} MB')

    assets_dir = os.path.join(a.out, 'assets')
    if os.path.isdir(assets_dir):
        shutil.rmtree(assets_dir)
    index = []
    count = 0
    for d in ON_DEMAND_DIRS:
        files = merged(sources, d)
        for key in sorted(files):
            rel, full = files[key]
            if any(key.startswith(c.lower() + '/') for c in CORE_TEXTURE_DIRS):
                continue
            dst = os.path.join(assets_dir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(full, dst)
            index.append(rel)
            count += 1
    with open(os.path.join(assets_dir, 'index.json'), 'w') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f'assets: {count} on-demand files')

    font = None
    for root in [r for r in (a.v171, a.base) if r]:
        p = os.path.join(root, 'play-regular.ttf')
        if os.path.isfile(p):
            font = p
            break
    if not font:
        sys.exit('play-regular.ttf not found')
    shutil.copyfile(font, os.path.join(a.out, 'play-regular.ttf'))


if __name__ == '__main__':
    main()
