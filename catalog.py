#!/usr/bin/env python3
"""
catalog.py — the Librarian's consistency pass.

Builds CATALOG.json (the single index the portal reads) from what's actually on
disk, then optionally fills metadata gaps and flags drift. Designed to run on
the always-on Mac mini (the Librarian) once a day.

What it does, in order:
  1. Scan STEMS/<base>/ and M4A/. For each song, record which renditions
     actually exist (6 stems? which m4a mixdowns?) with pointers to the files.
  2. Read each song's metadata.json for title/artist/bpm/key/etc.
  3. (--fill, default) Fill GAPS ONLY — never overwrite good data:
       - missing release_date  -> MusicBrainz lookup
       - missing bpm / key     -> compute locally with librosa from source.wav
  4. Write CATALOG.json at the repo root.
  5. Report drift: STEMS dirs with no metadata.json, metadata with no stems,
     m4a files with no STEMS dir, songs missing expected renditions.

This reuses metadata.py's analysis functions so the math stays in one place.

Usage:
    catalog.py                 # build catalog, fill gaps, print drift report
    catalog.py --no-fill       # build catalog only (no web/librosa work)
    catalog.py --report-only   # print drift, don't write CATALOG.json
    catalog.py --root DIR      # override the simpleStem root
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

# metadata.py (and its heavy deps numpy/librosa/soundfile) is imported LAZILY,
# only when --fill actually needs to compute bpm/key or hit MusicBrainz. That
# keeps plain index builds (and --no-fill) dependency-free, so they run anywhere
# — including a machine without librosa installed.
sys.path.insert(0, str(Path(__file__).resolve().parent))

EXPECTED_STEMS = ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar']
# m4a suffixes stem.sh currently emits (no leading underscore here; the file is
# <base>_<suffix>.m4a, e.g. Magic_Man_Heart_-V-G.m4a / ..._DO.m4a)
M4A_SUFFIXES = ['-V', '-V-G', '-V-G-B', 'DO']


def default_root():
    env = os.environ.get('SIMPLE_STEM_ROOT')
    if env:
        return Path(env)
    return Path.home() / 'ClaudeDrive' / 'simpleStem'


def load_metadata(stem_dir):
    """Return the parsed metadata.json for a STEMS/<base>/ dir, or {}."""
    p = stem_dir / 'metadata.json'
    if not p.exists():
        return {}
    try:
        return json.load(open(p))
    except Exception as e:
        print(f"   !! {p}: unreadable ({e})", file=sys.stderr)
        return {}


def stems_present(stem_dir):
    return [s for s in EXPECTED_STEMS if (stem_dir / f'{s}.wav').exists()]


def m4a_for(base, m4a_dir):
    """Map suffix -> relative path for the m4a files that exist for this base."""
    out = {}
    for suf in M4A_SUFFIXES:
        f = m4a_dir / f'{base}_{suf}.m4a'
        if f.exists():
            out[suf] = f'M4A/{f.name}'
    return out


def fill_gaps(base, stem_dir, meta):
    """Fill ONLY missing fields. Returns (meta, changed_bool)."""
    try:
        import metadata as md  # heavy deps (numpy/librosa/soundfile) — lazy
    except ImportError as e:
        print(f"   !! gap-fill skipped — metadata.py deps missing ({e}); "
              "install librosa+soundfile", file=sys.stderr)
        return meta, False

    changed = False
    src = stem_dir / 'source.wav'

    # bpm / key — compute locally, only if missing and we have the audio.
    need_bpm = not meta.get('bpm')
    need_key = not meta.get('key')
    if (need_bpm or need_key) and src.exists():
        try:
            bpm, key = md.detect_bpm_key(src)
            if need_bpm:
                meta['bpm'] = round(bpm, 1); changed = True
            if need_key:
                meta['key'] = key
                meta['key_signature'] = md.KEY_SIGNATURE.get(key, 'unknown')
                changed = True
            print(f"   + {base}: filled bpm/key locally")
        except Exception as e:
            print(f"   !! {base}: bpm/key detection failed ({e})", file=sys.stderr)

    # release_date — MusicBrainz, only if missing and we know title+artist.
    if not meta.get('release_date') and meta.get('title') and meta.get('artist'):
        rd = md.musicbrainz_release_date(meta['artist'], meta['title'])
        if rd:
            meta['release_date'] = rd
            changed = True
            print(f"   + {base}: filled release_date {rd} (MusicBrainz)")

    if changed:
        meta['catalog_filled_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        try:
            json.dump(meta, open(stem_dir / 'metadata.json', 'w'),
                      indent=2, ensure_ascii=False)
            open(stem_dir / 'metadata.json', 'a').write('\n')
        except Exception as e:
            print(f"   !! {base}: could not write metadata.json ({e})", file=sys.stderr)
    return meta, changed


def build(root, do_fill):
    stems_root = root / 'STEMS'
    m4a_root = root / 'M4A'
    catalog = {}
    drift = {'stems_without_metadata': [], 'metadata_without_stems': [],
             'incomplete': [], 'm4a_without_stems_dir': []}

    stem_dirs = sorted([d for d in stems_root.iterdir() if d.is_dir()]) \
        if stems_root.exists() else []

    for d in stem_dirs:
        base = d.name
        meta = load_metadata(d)
        if not meta:
            drift['stems_without_metadata'].append(base)
        if do_fill and meta:
            meta, _ = fill_gaps(base, d, meta)

        present = stems_present(d)
        if meta and not present:
            drift['metadata_without_stems'].append(base)

        m4a = m4a_for(base, m4a_root)
        renditions = {}
        if len(present) == len(EXPECTED_STEMS):
            renditions['stems_dir'] = f'STEMS/{base}/'
        elif present:
            renditions['stems_partial'] = present
        if m4a:
            renditions['m4a'] = m4a

        complete = len(present) == len(EXPECTED_STEMS) and len(m4a) == len(M4A_SUFFIXES)
        if not complete:
            drift['incomplete'].append(base)

        catalog[base] = {
            'title': meta.get('title'),
            'artist': meta.get('artist'),
            'bpm': meta.get('bpm'),
            'key': meta.get('key'),
            'key_signature': meta.get('key_signature'),
            'release_date': meta.get('release_date'),
            'version': meta.get('version'),
            'duration_sec': meta.get('duration_sec'),
            'source_url': meta.get('source_url'),
            'playlist_title': meta.get('playlist_title'),
            'sequence_number': meta.get('sequence_number'),
            'renditions': renditions,
            'status': 'complete' if complete else 'partial',
        }

    # m4a files whose STEMS/<base>/ dir is gone
    if m4a_root.exists():
        known = {d.name for d in stem_dirs}
        for f in sorted(m4a_root.glob('*.m4a')):
            stem = f.stem
            base = next((stem[:-(len(s) + 1)] for s in M4A_SUFFIXES
                         if stem.endswith('_' + s)), None)
            if base and base not in known:
                drift['m4a_without_stems_dir'].append(f.name)

    return catalog, drift


def print_drift(drift, catalog):
    n = len(catalog)
    complete = sum(1 for v in catalog.values() if v['status'] == 'complete')
    print(f"\n== catalog: {n} songs, {complete} complete, {n - complete} partial")
    for label, items in drift.items():
        if items:
            print(f"\n-- {label} ({len(items)}):")
            for it in items[:40]:
                print(f"     {it}")
            if len(items) > 40:
                print(f"     … +{len(items) - 40} more")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', type=Path, default=default_root())
    ap.add_argument('--no-fill', action='store_true',
                    help="don't fetch/compute missing fields, just index")
    ap.add_argument('--report-only', action='store_true',
                    help="print drift but don't write CATALOG.json")
    args = ap.parse_args()

    if not (args.root / 'STEMS').exists():
        print(f"!! no STEMS/ under {args.root}", file=sys.stderr)
        sys.exit(1)

    print(f">> scanning {args.root}")
    catalog, drift = build(args.root, do_fill=not args.no_fill)

    if not args.report_only:
        out = args.root / 'CATALOG.json'
        payload = {
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'count': len(catalog),
            'songs': catalog,
        }
        json.dump(payload, open(out, 'w'), indent=2, ensure_ascii=False)
        open(out, 'a').write('\n')
        print(f">> wrote {out.name} ({len(catalog)} songs)")

    print_drift(drift, catalog)


if __name__ == '__main__':
    main()
