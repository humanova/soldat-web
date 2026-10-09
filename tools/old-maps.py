#!/usr/bin/env python3
"""The older versions of Soldat's stock maps, for old demos (web/js/spectate/old-maps.js).

Many stock maps were reshaped between versions, so a demo played on 1.7.1's map can show its
players inside the ground. This finds, for each stock map, the versions whose ground (the
polygons a player collides with) differs from 1.7.1's by more than 1% of its area, merges
versions that collide alike, and writes into the asset mirror (web/assets):

  maps/<map>~<tag>.pms                 the newest file of each such version (tag: the first
                                       version with it, without "1." and dots: ~50 is 1.5.0);
                                       a map 1.7.1 lacks keeps its name for its newest version
  textures/, scenery-gfx/              what those maps draw that 1.7.1 does not have
  old-maps.json                        the files above, which build-assets.py keeps
  index.json                           with them
  web/js/spectate/old-maps-data.js     the list the page picks from

usage: old-maps.py GAMES_DIR       (GAMES_DIR/<version>/app/{Maps,Textures,Scenery-gfx}: the
                                    games' installers, innoextract -I app/Maps ..., version
                                    folders named 12 121 13 ... 169 170)
Needs numpy. Takes a few minutes.
"""
import glob
import json
import os
import shutil
import struct
import sys
import zipfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VERSIONS = ['12', '121', '13', '131', '14', '141', '142', '15', '160', '161', '162', '163', '164', '165', '166', '167',
            '168', '169', '170']
NAME = {v: '1.%s.%s' % (v[1], v[2:] or '0') for v in VERSIONS}           # '121' -> '1.2.1', '12' -> '1.2.0'
TAG = {v: v + ('0' if len(v) == 2 else '') for v in VERSIONS}            # '12' -> '120'
TAG = {v: t[1:] for v, t in TAG.items()}                                  # '120' -> '20'
PASSABLE = {1, 3, 10, 12, 14, 16, 23, 24, 25}  # bullets only, none, team bullets, flags, background
STEP = 8  # px of the raster the ground is compared on


def sstr(d, p, n):
    return d[p + 1:p + 1 + min(d[p], n)].decode('latin1')


def parse(d):
    """polygons [(ax, ay, bx, by, cx, cy, type)], texture, scenery file names (MapFile.pas)"""
    tex = sstr(d, 43, 24)
    n = struct.unpack_from('<i', d, 88)[0]
    polys, p = [], 92
    for _ in range(n):
        v = [struct.unpack_from('<ff', d, p + k * 28) for k in range(3)]
        polys.append((*v[0], *v[1], *v[2], d[p + 120]))
        p += 121
    div, num = struct.unpack_from('<ii', d, p)
    p += 8
    for _ in range((2 * num + 1) ** 2):
        p += 2 + 2 * struct.unpack_from('<H', d, p)[0]
    p += 4 + 44 * struct.unpack_from('<i', d, p)[0]
    scenery = []
    for _ in range(struct.unpack_from('<i', d, p)[0] if p + 4 <= len(d) else 0):
        scenery.append(sstr(d, p + 4, 50))
        p += 55
    p += 4
    return {'polys': polys, 'texture': tex, 'scenery': scenery}


def ground(m):
    """the solid triangles, rounded, as a set (for equality) and an array"""
    t = [tuple(round(x, 1) for x in q[:6]) for q in m['polys'] if q[6] not in PASSABLE]
    return frozenset(t), np.array(t, dtype=np.float64).reshape(-1, 6)


def raster(tris, box):
    x0, y0, x1, y1 = box
    w, h = int((x1 - x0) // STEP) + 2, int((y1 - y0) // STEP) + 2
    g = np.zeros((h, w), bool)
    for ax, ay, bx, by, cx, cy in tris:
        i0, i1 = int((min(ax, bx, cx) - x0) // STEP), int((max(ax, bx, cx) - x0) // STEP) + 1
        j0, j1 = int((min(ay, by, cy) - y0) // STEP), int((max(ay, by, cy) - y0) // STEP) + 1
        X, Y = np.meshgrid(x0 + (np.arange(i0, i1) + .5) * STEP, y0 + (np.arange(j0, j1) + .5) * STEP)
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-9:
            continue
        l1 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / d
        l2 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / d
        g[j0:j1, i0:i1] |= (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
    return g


def differ(a, b):
    """the share of the solid area that one has and the other has not"""
    if a[0] == b[0]:
        return 0.0
    pts = np.vstack([a[1].reshape(-1, 2), b[1].reshape(-1, 2)])
    box = (*pts.min(0), *pts.max(0))
    ga, gb = raster(a[1], box), raster(b[1], box)
    return float((ga ^ gb).sum() / max((ga | gb).sum(), 1))


def files(games, v, sub):
    """{lower-case name: path} of a version's files in app/<sub> (any case)"""
    out = {}
    for d in glob.glob(os.path.join(games, v, 'app', '*')):
        if os.path.basename(d).lower() == sub:
            for f in glob.glob(os.path.join(d, '*')):
                if os.path.isfile(f):
                    out[os.path.basename(f).lower()] = f
    return out


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    games = sys.argv[1]
    smod = zipfile.ZipFile(os.path.join(ROOT, 'web', 'soldat.smod'))
    own = {n.split('/')[-1].lower(): (os.path.splitext(n.split('/')[-1])[0], ground(parse(smod.read(n))))
           for n in smod.namelist() if n.lower().startswith('maps/') and n.lower().endswith('.pms')}
    # the files of an earlier run go: what 1.7.1's files have is what is left
    assets = os.path.join(ROOT, 'web', 'assets')
    manifest = os.path.join(assets, 'old-maps.json')
    earlier = json.load(open(manifest)) if os.path.isfile(manifest) else []
    for rel in earlier:
        if os.path.isfile(os.path.join(assets, rel)):
            os.remove(os.path.join(assets, rel))
    index = [p for p in json.load(open(os.path.join(assets, 'index.json'))) if p not in set(earlier)]
    have = {p.lower() for p in index} | {n.lower() for n in smod.namelist()}

    maps = {}  # lower-case map file name -> [(version, path, parsed, ground)]
    for v in VERSIONS:
        for name, f in files(games, v, 'maps').items():
            if name.endswith('.pms'):
                m = parse(open(f, 'rb').read())
                maps.setdefault(name, []).append((v, f, m, ground(m)))

    written = []
    os.makedirs(os.path.join(assets, 'maps'), exist_ok=True)
    listing, needed = {}, {}
    for name, items in sorted(maps.items()):
        groups = []  # [ground, [versions], newest path, parsed]
        for v, f, m, g in items:
            for grp in groups:
                if differ(grp[0], g) < 0.005:
                    grp[1].append(v)
                    grp[2], grp[3] = f, m
                    break
            else:
                groups.append([g, [v], f, m])
        mine = own.get(name)
        keep = [grp for grp in groups if not mine or differ(grp[0], mine[1]) > 0.01]
        if not keep:
            continue
        base = mine[0] if mine else os.path.splitext(os.path.basename(keep[-1][2]))[0]
        entries = []
        for grp in keep:
            plain = not mine and grp is keep[-1]  # a map 1.7.1 lacks: its newest under its name
            file_name = base if plain else '%s~%s' % (base, TAG[grp[1][0]])
            assert len(file_name) <= 16, file_name
            shutil.copyfile(grp[2], os.path.join(assets, 'maps', file_name + '.pms'))
            written.append('maps/' + file_name + '.pms')
            entries.append([file_name, ' '.join(NAME[v] for v in grp[1])])
            # what it draws: from the newest of its versions that has it
            for sub, want in [('textures', [grp[3]['texture']]), ('scenery-gfx', grp[3]['scenery'])]:
                for w in want:
                    stem = os.path.splitext(w.lower())[0]
                    if not stem or any(sub + '/' + stem + ext in have for ext in ('.png', '.bmp', '.jpg', '.gif')):
                        continue
                    for v in list(reversed(grp[1])) + list(reversed(VERSIONS)):
                        src = next((p for n, p in files(games, v, sub).items() if os.path.splitext(n)[0] == stem), None)
                        if src:
                            needed[sub + '/' + os.path.basename(src)] = src
                            break
        listing[name[:-4]] = entries
        print('%-18s %s' % (name, '  '.join('%s (%s)' % (e[0], e[1]) for e in entries)))

    for rel, src in sorted(needed.items()):
        shutil.copyfile(src, os.path.join(assets, rel))
        written.append(rel)
    written.sort()
    with open(manifest, 'w') as fh:
        json.dump(written, fh, indent=0)
    with open(os.path.join(assets, 'index.json'), 'w') as fh:
        json.dump(index + written, fh, separators=(',', ':'))
    print('graphics:', len(needed), ' '.join(sorted(needed)))

    with open(os.path.join(ROOT, 'web', 'js', 'spectate', 'old-maps-data.js'), 'w') as fh:
        fh.write('// Generated by tools/old-maps.py: the older versions of the stock maps whose ground differs\n'
                 '// from 1.7.1\'s (web/assets/maps/<name>.pms), with the versions that came with each.\n'
                 'export const OLD_MAPS = {\n')
        for name, entries in listing.items():
            fh.write('  %s: %s,\n' % (json.dumps(name), json.dumps(entries)))
        fh.write('};\n')
    print('maps:', len(listing), 'files:', sum(len(e) for e in listing.values()))


if __name__ == '__main__':
    main()
