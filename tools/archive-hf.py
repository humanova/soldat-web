#!/usr/bin/env python3
"""Moves Soldat TV's old recordings to a public Hugging Face dataset.

The recordings older than the config's recordings.keepDays (relay/spectator.json) go up with
their metadata, the Soldat Reloaded maps they need, and an index.jsonl of every match. A
recording is deleted here only once Hugging Face holds both its files, the same size and
hash. The relay (recordings.archive) never deletes one itself, and forgets those removed here
within the hour.

  python3 tools/archive-hf.py              # push, check, delete
  python3 tools/archive-hf.py --dry-run    # only list what would go

Needs huggingface_hub and a write token (hf auth login).
"""
import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')   # before huggingface_hub reads it

from huggingface_hub import CommitOperationAdd, HfApi, hf_hub_download
from huggingface_hub.utils import EntryNotFoundError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BATCH = 200   # matches a commit

CARD = """---
pretty_name: Soldat TV recordings
tags:
- soldat
- game-replays
configs:
- config_name: default
  data_files: index.jsonl
---

# Soldat TV recordings

Matches [Soldat TV](https://soldat.live) recorded on Gather servers, moved here once they are
older than the site keeps them.

- `recordings/<YYYY-MM>/<id>.json`: the match: server, map, mode, start and end (ms since
  1970, UTC), players and teams, scores, highlights and rating.
- `recordings/<YYYY-MM>/<id>.sdm.gz`: a Soldat 1.7.1 demo, gzipped.
- `recordings/<YYYY-MM>/<id>.srdm.gz`: a Soldat Reloaded demo, gzipped; its map is
  `maps/reloaded/<mapHash>`.
- `index.jsonl`: every match's metadata, one a line.

A demo plays in [Soldat TV's demo player](https://soldat.live/#demo) once gunzipped.
"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def git_blob(path):
    with open(path, 'rb') as f:
        data = f.read()
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def same(local, remote):
    """whether the file on Hugging Face is the local one"""
    if remote is None or remote.size != os.path.getsize(local):
        return False
    if remote.lfs is not None:
        return remote.lfs.sha256 == sha256(local)
    return remote.blob_id == git_blob(local)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', default=os.path.join(ROOT, 'relay/spectator.json'))
    ap.add_argument('--repo', default='Emir/soldat-tv-recordings')
    ap.add_argument('--days', type=float, help='older than this many days (default: keepDays)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    config = json.load(open(args.config))
    rec = config.get('recordings', {})
    base = os.path.dirname(os.path.abspath(args.config))
    rdir = os.path.join(base, rec.get('dir', 'data/recordings'))
    mdir = os.path.join(base, config.get('reloaded', {}).get('dir', 'data/reloaded'))
    days = args.days if args.days is not None else rec.get('keepDays', 14)
    before = (time.time() - days * 86400) * 1000

    old = []
    for f in sorted(os.listdir(rdir)):
        if not f.endswith('.json'):
            continue
        try:
            meta = json.load(open(os.path.join(rdir, f)))
        except ValueError:
            continue
        demo = meta['id'] + ('.srdm' if meta.get('game') == 'reloaded' else '.sdm') + '.gz'
        if meta['start'] < before and os.path.exists(os.path.join(rdir, demo)):
            month = datetime.fromtimestamp(meta['start'] / 1000, timezone.utc).strftime('%Y-%m')
            old.append((meta, f, demo, f'recordings/{month}'))
    size = sum(os.path.getsize(os.path.join(rdir, d)) for _, _, d, _ in old)
    print(f'{len(old)} recordings older than {days:g} days, {size / 1e6:.0f} MB')
    if args.dry_run or not old:
        for meta, *_ in old:
            print(' ', meta['id'])
        return

    api = HfApi()
    api.create_repo(args.repo, repo_type='dataset', exist_ok=True)
    try:
        prev = hf_hub_download(args.repo, 'index.jsonl', repo_type='dataset', force_download=True)
        index = {m['id']: m for m in map(json.loads, open(prev))}
    except EntryNotFoundError:
        index = {}
    have = {e.path for e in api.list_repo_tree(args.repo, repo_type='dataset', recursive=True)}

    removed = 0
    for i in range(0, len(old), BATCH):
        batch = old[i:i + BATCH]
        ops, maps = [], set()
        for meta, f, demo, at in batch:
            ops.append(CommitOperationAdd(f'{at}/{f}', os.path.join(rdir, f)))
            ops.append(CommitOperationAdd(f'{at}/{demo}', os.path.join(rdir, demo)))
            index[meta['id']] = meta
            h = meta.get('mapHash')
            if h and f'maps/reloaded/{h}' not in have and os.path.exists(os.path.join(mdir, h)):
                maps.add(h)
        for h in sorted(maps):
            ops.append(CommitOperationAdd(f'maps/reloaded/{h}', os.path.join(mdir, h)))
        lines = ''.join(json.dumps(m) + '\n' for m in sorted(index.values(), key=lambda m: m['start']))
        ops.append(CommitOperationAdd('index.jsonl', lines.encode()))
        if 'README.md' not in have:
            ops.append(CommitOperationAdd('README.md', CARD.encode()))
            have.add('README.md')
        api.create_commit(args.repo, ops, repo_type='dataset',
                          commit_message=f'Add {len(batch)} recordings')
        have |= {f'maps/reloaded/{h}' for h in maps}

        # deleted only once both files are on Hugging Face as they are here
        paths = [p for _, f, demo, at in batch for p in (f'{at}/{f}', f'{at}/{demo}')]
        remote = {}
        for j in range(0, len(paths), 100):
            for e in api.get_paths_info(args.repo, paths[j:j + 100], repo_type='dataset', expand=True):
                remote[e.path] = e
        for meta, f, demo, at in batch:
            jl, dl = os.path.join(rdir, f), os.path.join(rdir, demo)
            if same(jl, remote.get(f'{at}/{f}')) and same(dl, remote.get(f'{at}/{demo}')):
                os.remove(dl)
                os.remove(jl)
                removed += 1
            else:
                print(f'  {meta["id"]}: not on Hugging Face as it is here, kept', file=sys.stderr)
        print(f'pushed {len(batch)}, removed {removed} so far')
    print(f'done: {removed} of {len(old)} recordings moved to https://huggingface.co/datasets/{args.repo}')
    if removed < len(old):
        sys.exit(1)


if __name__ == '__main__':
    main()
