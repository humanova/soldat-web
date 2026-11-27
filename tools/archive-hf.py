#!/usr/bin/env python3
"""Keeps Soldat TV's recordings on a public Hugging Face dataset, and frees the old ones here.

Every recording not yet on Hugging Face goes up (or again, when its metadata changed: a Soldat
Reloaded match's highlights are found after it is kept), with the Soldat Reloaded maps the
demos need and an index of every match, by game. Then those older than the config's
recordings.keepDays (relay/spectator.json) are deleted here, only once Hugging Face holds both
their files, the same size and hash, along with their hard links in ~/data/soldat-archive
(deploy/soldat-archive/link_new.sh), or no space is freed. The relay (recordings.archive)
never deletes one itself, and forgets those removed here within the hour.

  python3 tools/archive-hf.py --dry-run     # only list what would go up and be deleted
  python3 tools/archive-hf.py --no-delete   # only push
  python3 tools/archive-hf.py               # push, then check and delete the old ones

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

from huggingface_hub import CommitOperationAdd, HfApi
from huggingface_hub.hf_api import RepoFile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BATCH_BYTES = 1 << 30   # a commit
GAMES = {'1.7.1': 'Soldat 1.7.1', 'reloaded': 'Soldat Reloaded'}
IMAGE = os.path.join(ROOT, 'web/og-2.jpg')   # the card's picture: Soldat TV's share image

CARD = """---
pretty_name: Soldat TV Gather recordings
tags:
- soldat
- game-replays
configs:
- config_name: reloaded
  data_files: index/reloaded.jsonl
- config_name: '1.7.1'
  data_files: index/1.7.1.jsonl
---

# Soldat TV Gather recordings

![Soldat TV: watch live Soldat matches in your browser](https://huggingface.co/datasets/Emir/soldat-tv-recordings/resolve/main/images/soldat-tv.jpg)

Official Soldat matchmaking matches: the Gather servers' games
[Soldat TV](https://soldat.live) recorded while someone was watching, so some matches are
missing and some start late. A match is listed on [soldat.live/stats](https://soldat.live/stats/)
and watchable there for its first 120 days; all of them stay here.

The two games' recordings are apart, and their demos do not play in each other:

- **Soldat Reloaded** (`reloaded/`): the Reloaded Gather servers, CTF-Casual and CTF-Ranked.
  A demo is a `.srdm`; its map is `maps/reloaded/<mapHash>`.
- **Soldat 1.7.1** (`1.7.1/`): the 1.7.1 Gather CTF servers. A demo is a `.sdm`; its map
  is one of the game's own, by name.

Files:

- `<game>/<YYYY-MM>/<id>.json`: the match: server, map, mode, start and end (ms since 1970,
  UTC), players and teams, scores, highlights and rating.
- `<game>/<YYYY-MM>/<id>.sdm.gz` or `.srdm.gz`: the demo, gzipped.
- `index/<game>.jsonl`: every match's metadata, one a line (the dataset viewer's two subsets).

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


def same(local, remote, deep=True):
    """whether the file on Hugging Face is the local one: a demo never changes once kept, so
    its size tells for the push; deep, before deleting, its hash too"""
    if remote is None or remote.size != os.path.getsize(local):
        return False
    if remote.lfs is not None:
        return not deep or remote.lfs.sha256 == sha256(local)
    return remote.blob_id == git_blob(local)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--config', default=os.path.join(ROOT, 'relay/spectator.json'))
    ap.add_argument('--repo', default='Emir/soldat-tv-recordings')
    ap.add_argument('--links', default=os.path.expanduser('~/data/soldat-archive/recordings'),
                    help='the hard links kept of the recordings, removed with them')
    ap.add_argument('--days', type=float, help='delete those older than this many days (default: keepDays)')
    ap.add_argument('--no-delete', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    config = json.load(open(args.config))
    rec = config.get('recordings', {})
    base = os.path.dirname(os.path.abspath(args.config))
    rdir = os.path.join(base, rec.get('dir', 'data/recordings'))
    mdir = os.path.join(base, config.get('reloaded', {}).get('dir', 'data/reloaded'))
    days = args.days if args.days is not None else rec.get('keepDays', 14)
    before = (time.time() - days * 86400) * 1000

    # the finished recordings here: (meta, json, demo, the folder on Hugging Face)
    local = []
    for f in sorted(os.listdir(rdir)):
        if not f.endswith('.json'):
            continue
        try:
            meta = json.load(open(os.path.join(rdir, f)))
        except ValueError:
            continue
        game = 'reloaded' if meta.get('game') == 'reloaded' else '1.7.1'
        demo = meta['id'] + ('.srdm' if game == 'reloaded' else '.sdm') + '.gz'
        if os.path.exists(os.path.join(rdir, demo)):
            month = datetime.fromtimestamp(meta['start'] / 1000, timezone.utc).strftime('%Y-%m')
            local.append((meta, f, demo, f'{game}/{month}'))

    api = HfApi()
    api.create_repo(args.repo, repo_type='dataset', exist_ok=True)
    remote = {e.path: e for e in api.list_repo_tree(args.repo, repo_type='dataset', recursive=True, expand=True)
              if isinstance(e, RepoFile)}

    # the index: what Hugging Face has, with every match here over it
    index = {g: {} for g in GAMES}
    for g in GAMES:
        if f'index/{g}.jsonl' in remote:
            path = api.hf_hub_download(args.repo, f'index/{g}.jsonl', repo_type='dataset', force_download=True)
            index[g] = {m['id']: m for m in map(json.loads, open(path))}
    for meta, _, _, at in local:
        index[at.split('/')[0]][meta['id']] = meta

    todo = [r for r in local if not (same(os.path.join(rdir, r[1]), remote.get(f'{r[3]}/{r[1]}'))
                                     and same(os.path.join(rdir, r[2]), remote.get(f'{r[3]}/{r[2]}'), deep=False))]
    size = sum(os.path.getsize(os.path.join(rdir, d)) for _, _, d, _ in todo)
    old = [r for r in local if r[0]['start'] < before]
    print(f'{len(local)} recordings here: {len(todo)} to push ({size / 1e6:.0f} MB), '
          f'{0 if args.no_delete else len(old)} older than {days:g} days to delete once on Hugging Face')
    if args.dry_run:
        for meta, *_ in todo:
            print('  push', meta['id'])
        for meta, *_ in ([] if args.no_delete else old):
            print('  delete', meta['id'])
        return

    # pushed in commits of about BATCH_BYTES; the index and card with the last
    batches, batch, n = [], [], 0
    for r in todo:
        batch.append(r)
        n += os.path.getsize(os.path.join(rdir, r[2]))
        if n >= BATCH_BYTES:
            batches.append(batch)
            batch, n = [], 0
    batches.append(batch)
    pushed = 0
    for i, batch in enumerate(batches):
        ops, maps = [], set()
        for meta, f, demo, at in batch:
            ops.append(CommitOperationAdd(f'{at}/{f}', os.path.join(rdir, f)))
            ops.append(CommitOperationAdd(f'{at}/{demo}', os.path.join(rdir, demo)))
            h = meta.get('mapHash')
            if h and f'maps/reloaded/{h}' not in remote and os.path.exists(os.path.join(mdir, h)):
                maps.add(h)
        for h in sorted(maps):
            ops.append(CommitOperationAdd(f'maps/reloaded/{h}', os.path.join(mdir, h)))
        if i == len(batches) - 1:
            for g in GAMES:
                lines = ''.join(json.dumps(m) + '\n' for m in sorted(index[g].values(), key=lambda m: m['start']))
                ops.append(CommitOperationAdd(f'index/{g}.jsonl', lines.encode()))
            ops.append(CommitOperationAdd('README.md', CARD.encode()))
            if 'images/soldat-tv.jpg' not in remote:
                ops.append(CommitOperationAdd('images/soldat-tv.jpg', IMAGE))
        api.create_commit(args.repo, ops, repo_type='dataset',
                          commit_message=f'Add {len(batch)} recordings' if batch else 'Update the index')
        remote.update({f'maps/reloaded/{h}': True for h in maps})
        pushed += len(batch)
        print(f'pushed {pushed} of {len(todo)}', flush=True)
    if args.no_delete or not old:
        return

    # deleted only once both files are on Hugging Face as they are here
    paths = [p for _, f, demo, at in old for p in (f'{at}/{f}', f'{at}/{demo}')]
    remote = {}
    for j in range(0, len(paths), 100):
        for e in api.get_paths_info(args.repo, paths[j:j + 100], repo_type='dataset', expand=True):
            remote[e.path] = e
    removed = 0
    for meta, f, demo, at in old:
        jl, dl = os.path.join(rdir, f), os.path.join(rdir, demo)
        if same(jl, remote.get(f'{at}/{f}')) and same(dl, remote.get(f'{at}/{demo}')):
            for name, path in ((demo, dl), (f, jl)):
                link = os.path.join(args.links, name)
                if os.path.exists(link) and os.path.samefile(link, path):
                    os.remove(link)
                os.remove(path)
            removed += 1
        else:
            print(f'  {meta["id"]}: not on Hugging Face as it is here, kept', file=sys.stderr)
    print(f'deleted {removed} of {len(old)} old recordings, all on https://huggingface.co/datasets/{args.repo}')
    if removed < len(old):
        sys.exit(1)


if __name__ == '__main__':
    main()
