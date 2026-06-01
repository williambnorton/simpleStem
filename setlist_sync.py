#!/usr/bin/env python3
"""
setlist_sync.py — keep persistent SetLists in sync with YouTube playlists.

The Librarian owns a registry of YouTube *playlist* URLs. Each registered
playlist becomes a living, ordered **SetList** in the library. On every sync the
Librarian re-reads the playlist and makes the SetList match it:

  - ORDER:    YouTube is the authority — the SetList is re-sorted to the
              playlist's current order every time.
  - ADDED:    a playlist entry we don't have yet → drop a .webloc into
              INCOMING_WEBLOC/ so the normal ingest path downloads + caches it
              and queues it for stemming. (We don't re-implement download here;
              webloc_watch.sh already does it, once, on the Librarian.)
  - REMOVED:  a song no longer in the playlist → dropped from the SetList only.
              Its stems/m4a/source stay in the library (still searchable/reusable).
  - PRESENT:  already in the library (matched by stable video_id) → just placed
              at its new position. No re-download.

Files (all under the simpleStem root):
  SETLISTS/registry.json          {playlist_id: {url, title, added_at}}
  SETLISTS/<slug>.json            the living SetList (ordered entries + status)

Identity: songs are matched to playlist entries by YouTube **video_id**, derived
identically to lib-common.sh's video_id() so a song downloaded earlier (whose
metadata.json may store a full URL or a bare id) is recognized and never re-fetched.

Usage:
    setlist_sync.py --add URL [--name NAME]   register a playlist (then sync it)
    setlist_sync.py --list                     show registered playlists
    setlist_sync.py --remove PLAYLIST_ID       unregister (keeps the SetList file)
    setlist_sync.py                            sync ALL registered playlists
    setlist_sync.py --sync PLAYLIST_ID         sync just one
    setlist_sync.py --dry-run                  show what would change, do nothing
    setlist_sync.py --root DIR                 override the simpleStem root

Requires yt-dlp on PATH (to read playlists). No heavy deps.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


# ── identity + slug (mirror lib-common.sh exactly) ──────────────────────────
def slugify(s):
    s = re.sub(r'[^A-Za-z0-9_-]', '_', s or '')
    s = re.sub(r'_+', '_', s)
    return s.strip('_')


# Characters allowed in a human SetList name: letters, digits, space, _ . - ' & ( )
# Anything else (/, :, ?, =, &-in-urls beyond the allowed set, etc.) is rejected so
# a URL pasted into a name slot fails loudly instead of being mangled into a junk
# filename like "https_www_youtube_com_playlist_list_...".
_NAME_OK = re.compile(r"^[A-Za-z0-9 _.\-'&()]+$")


def reject_bad_name(name):
    """Exit with a clear message if `name` isn't a clean, filesystem-safe SetList name."""
    n = (name or '').strip()
    if not n:
        print("!! SetList name is empty.", file=sys.stderr); sys.exit(1)
    looks_like_url = '://' in n or n.lower().startswith('www.') or 'list=' in n
    if looks_like_url:
        print(f"!! \"{n}\" looks like a URL, not a name.\n"
              "   To register a playlist for syncing, use:\n"
              "     --add 'URL' --name 'Friendly Name'\n"
              "   (--new-manual takes a NAME, not a URL.)", file=sys.stderr)
        sys.exit(1)
    if not _NAME_OK.match(n):
        bad = sorted(set(c for c in n if not _NAME_OK.match(c)))
        print(f"!! SetList name has unsafe character(s): {' '.join(repr(c) for c in bad)}\n"
              "   Allowed: letters, digits, space, and  _ . - ' & ( )", file=sys.stderr)
        sys.exit(1)
    return n


def video_id(url_or_id):
    """Bare 11-char YouTube id from a watch/youtu.be/embed/shorts URL or id."""
    s = (url_or_id or '').strip()
    m = re.search(r'(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})', s)
    if m:
        return m.group(1)
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', s):
        return s
    return ''


def playlist_id(url):
    m = re.search(r'[?&]list=([A-Za-z0-9_-]+)', url or '')
    return m.group(1) if m else ''


def default_root():
    env = os.environ.get('SIMPLE_STEM_ROOT')
    return Path(env) if env else Path.home() / 'ClaudeDrive' / 'simpleStem'


# ── library index: video_id -> what we already have ─────────────────────────
def index_library(root):
    """Map every known video_id to its song_base + status from STEMS/*/metadata.json."""
    idx = {}
    stems_root = root / 'STEMS'
    if not stems_root.exists():
        return idx
    for d in sorted(stems_root.iterdir()):
        if not d.is_dir():
            continue
        meta = d / 'metadata.json'
        if not meta.exists():
            continue
        try:
            m = json.load(open(meta))
        except Exception:
            continue
        vid = video_id(m.get('source_url') or '')
        if not vid:
            continue
        n_stems = sum((d / f'{s}.wav').exists()
                      for s in ('vocals', 'drums', 'bass', 'other', 'piano', 'guitar'))
        idx[vid] = {
            'base': d.name,
            'title': m.get('title'),
            'artist': m.get('artist'),
            'stems_complete': n_stems == 6,
        }
    return idx


def queued_video_ids(root):
    """video_ids already sitting in STEM_QUEUE (awaiting render) or INCOMING."""
    out = set()
    for sub in ('STEM_QUEUE', 'INCOMING_WEBLOC'):
        base = root / sub
        if not base.exists():
            continue
        for p in base.rglob('*'):
            if p.suffix == '.json':
                try:
                    vid = video_id(json.load(open(p)).get('source_url') or '')
                    if vid:
                        out.add(vid)
                except Exception:
                    pass
            elif p.suffix == '.webloc':
                vid = video_id(p.read_text(errors='ignore'))
                if vid:
                    out.add(vid)
    return out


# ── yt-dlp: read a playlist's current ordered entries ───────────────────────
def fetch_playlist(url):
    """Return (playlist_title, [{'video_id','title','position'}...]) via yt-dlp."""
    try:
        out = subprocess.run(
            ['yt-dlp', '--flat-playlist', '-J', url],
            capture_output=True, text=True, timeout=120, check=True).stdout
    except FileNotFoundError:
        print("!! yt-dlp not found on PATH", file=sys.stderr); return None, []
    except subprocess.CalledProcessError as e:
        print(f"!! yt-dlp failed: {e.stderr.strip()[:200]}", file=sys.stderr); return None, []
    except subprocess.TimeoutExpired:
        print("!! yt-dlp timed out reading playlist", file=sys.stderr); return None, []
    try:
        d = json.loads(out)
    except Exception as e:
        print(f"!! could not parse yt-dlp output: {e}", file=sys.stderr); return None, []
    title = d.get('title') or 'playlist'
    entries = []
    for i, e in enumerate(d.get('entries') or [], 1):
        if not e or not e.get('id'):
            continue
        entries.append({'video_id': e['id'],
                        'title': (e.get('title') or '').strip(),
                        'position': i})
    return title, entries


# ── webloc drop (reuse the existing ingest path) ────────────────────────────
def drop_webloc(root, vid, label, dry):
    """Queue a single video for ingest by writing a .webloc into INCOMING_WEBLOC/."""
    incoming = root / 'INCOMING_WEBLOC'
    url = f'https://www.youtube.com/watch?v={vid}'
    dest = incoming / f'setlist_{vid}.webloc'
    if dry:
        print(f"   would queue ingest: {label} ({vid})")
        return
    incoming.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><dict><key>URL</key>'
        f'<string>{url}</string></dict></plist>\n')
    print(f"   queued ingest: {label} ({vid})")


# ── the sync itself ─────────────────────────────────────────────────────────
def setlists_dir(root):
    d = root / 'SETLISTS'
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_registry(root):
    p = setlists_dir(root) / 'registry.json'
    if p.exists():
        try:
            return json.load(open(p))
        except Exception:
            pass
    return {}


def save_registry(root, reg):
    p = setlists_dir(root) / 'registry.json'
    json.dump(reg, open(p, 'w'), indent=2, ensure_ascii=False)
    open(p, 'a').write('\n')


def sync_one(root, pid, entry, lib, queued, dry):
    url = entry['url']
    yt_title, pl_entries = fetch_playlist(url)
    if yt_title is None:
        print(f"!! {pid}: could not read playlist; leaving SetList unchanged")
        return
    title = entry.get('title') or yt_title
    print(f"== syncing SetList \"{title}\" ({len(pl_entries)} entries)")

    songs, n_have, n_queued, n_new = [], 0, 0, 0
    for e in pl_entries:
        vid = e['video_id']
        have = lib.get(vid)
        if have:
            status = 'ready' if have['stems_complete'] else 'rendering'
            n_have += 1
            songs.append({'position': e['position'], 'video_id': vid,
                          'title': have['title'] or e['title'],
                          'artist': have['artist'],
                          'song_base': have['base'], 'status': status})
        elif vid in queued:
            n_queued += 1
            songs.append({'position': e['position'], 'video_id': vid,
                          'title': e['title'], 'artist': None,
                          'song_base': None, 'status': 'queued'})
        else:
            drop_webloc(root, vid, e['title'], dry)
            queued.add(vid)
            n_new += 1
            songs.append({'position': e['position'], 'video_id': vid,
                          'title': e['title'], 'artist': None,
                          'song_base': None, 'status': 'queued'})

    setlist = {
        'origin': 'playlist',   # sync owns this file; manual setlists are never touched
        'playlist_id': pid, 'title': title, 'source_url': url,
        'synced_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'count': len(songs),
        'songs': songs,   # already in YouTube order (authority)
    }
    out = setlists_dir(root) / f'{slugify(title)}.json'
    # Safety: never overwrite a manually-curated SetList that happens to share a
    # name. Only a file we previously wrote as origin=playlist may be replaced.
    if out.exists():
        try:
            existing = json.load(open(out))
            if existing.get('origin') == 'manual':
                print(f"   !! {out.name} is a MANUAL setlist — skipping (rename the "
                      "playlist to avoid the clash)", file=sys.stderr)
                return
        except Exception:
            pass
    if dry:
        print(f"   would write {out.name}: {n_have} ready/rendering, "
              f"{n_queued} already queued, {n_new} newly queued")
    else:
        json.dump(setlist, open(out, 'w'), indent=2, ensure_ascii=False)
        open(out, 'a').write('\n')
        print(f"   wrote {out.name}: {n_have} in library, "
              f"{n_queued} already queued, {n_new} newly queued")


def sync_all(root, only_pid, dry):
    reg = load_registry(root)
    if not reg:
        print("(no playlists registered — add one with --add URL)")
        return
    lib = index_library(root)
    queued = queued_video_ids(root)
    for pid, entry in reg.items():
        if only_pid and pid != only_pid:
            continue
        sync_one(root, pid, entry, lib, queued, dry)


# ── CLI ──────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', type=Path, default=default_root())
    ap.add_argument('--add', metavar='URL')
    ap.add_argument('--name', metavar='NAME', help='friendly SetList name for --add')
    ap.add_argument('--remove', metavar='PLAYLIST_ID')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--sync', metavar='PLAYLIST_ID')
    ap.add_argument('--new-manual', metavar='NAME',
                    help='create an empty MANUAL setlist (curated from library songs; '
                         'never touched by playlist sync)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    root = args.root

    if args.new_manual:
        reject_bad_name(args.new_manual)
        out = setlists_dir(root) / f'{slugify(args.new_manual)}.json'
        if out.exists():
            print(f"!! {out.name} already exists", file=sys.stderr); sys.exit(1)
        json.dump({'origin': 'manual', 'title': args.new_manual,
                   'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                   'count': 0, 'songs': []},
                  open(out, 'w'), indent=2, ensure_ascii=False)
        open(out, 'a').write('\n')
        print(f"created manual setlist {out.name} — add songs (by song_base) in the "
              "portal or by editing the file; sync will never modify it")
        return

    if args.list:
        reg = load_registry(root)
        if not reg:
            print("(no playlists registered)")
        for pid, e in reg.items():
            print(f"  {pid}  {e.get('title') or '(untitled)'}\n      {e['url']}")
        return

    if args.remove:
        reg = load_registry(root)
        if args.remove in reg:
            removed = reg.pop(args.remove)
            save_registry(root, reg)
            print(f"unregistered {args.remove} ({removed.get('title')}); "
                  "SetList file left in place")
        else:
            print(f"!! {args.remove} not registered", file=sys.stderr)
        return

    if args.add:
        if args.name:
            reject_bad_name(args.name)   # --name is a title, not a URL
        pid = playlist_id(args.add)
        if not pid:
            print("!! that URL has no ?list= playlist id", file=sys.stderr); sys.exit(1)
        reg = load_registry(root)
        reg[pid] = {'url': args.add, 'title': args.name or '',
                    'added_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        if not args.dry_run:
            save_registry(root, reg)
        print(f"registered playlist {pid}")
        sync_all(root, pid, args.dry_run)
        return

    sync_all(root, args.sync, args.dry_run)


if __name__ == '__main__':
    main()
