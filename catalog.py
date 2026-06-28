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
       - missing bpm / key     -> compute locally with librosa from source.wav
       (release_date / MusicBrainz lookup retired 2026-06-28.)
  4. Write CATALOG.json at the repo root.
  5. Report drift: STEMS dirs with no metadata.json, metadata with no stems,
     m4a files with no STEMS dir, songs missing expected renditions.

Output shape MUST match what the Performer's server.js reads in
tryLoadFromCatalog + the row shapes produced by scanStems / scanM4a. The
canonical shape is documented in prompts/librarian_catalog_canonical_shape.md.

Usage:
    catalog.py                 # build catalog, fill gaps, print drift report
    catalog.py --no-fill       # build catalog only (no web/librosa work)
    catalog.py --report-only   # print drift, don't write CATALOG.json
    catalog.py --root DIR      # override the simpleStem root
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# metadata.py (and its heavy deps numpy/librosa/soundfile) is imported LAZILY,
# only when --fill actually needs to compute bpm/key. That keeps plain index
# builds (and --no-fill) dependency-free, so they run anywhere
# — including a machine without librosa installed.
sys.path.insert(0, str(Path(__file__).resolve().parent))

EXPECTED_STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
M4A_SUFFIXES = ['-V', '-V-G', '-V-G-B', 'DO']

# MusicBrainz lookup + circuit breaker retired 2026-06-28 — Bill uses the
# Performer's lyrics dialog (Google / Ultimate Guitar / AZLyrics) and
# manual Google searches for any external data. No more rate-limit noise,
# no more 110-line 503 dumps in the log.

# Mirror of the JS VARIANT_PATTERNS in scanM4a (server.js). First match wins.
VARIANT_PATTERNS = [
    (re.compile(r'_-V-G-B$', re.I), '-V-G-B', 'No Vocals/Guitar/Bass'),
    (re.compile(r'_-V-G$',   re.I), '-V-G',   'No Vocals/Guitar'),
    (re.compile(r'_-V-B$',   re.I), '-V-B',   'No Vocals/Bass'),
    (re.compile(r'_-V$',     re.I), '-V',     'No Vocals'),
    (re.compile(r'_DO$',     re.I), 'DO',     'Drums Only'),
]

# Skip rules — must match scanM4a / scanStems exactly.
DRIVE_DUP_M4A_RE = re.compile(r' \(\d+\)\.m4a$', re.I)
LOOP_M4A_RE      = re.compile(r'[_ ]loop\d+[_ ]\d+bars\.m4a$', re.I)
DRIVE_DUP_DIR_RE = re.compile(r' \(\d+\)$')

# Per-folder loop filename pattern (mirrors scanStems in server.js).
PER_FOLDER_LOOP_RE = re.compile(r'^([a-z+]+)_loop(\d+)_(\d+)bars\.(m4a|wav)$', re.I)


def _extract_video_id(source_url):
    """Pull the YouTube video ID out of a source URL. Mirrors the JS
    extractVideoId() in app.js so client-side ingest-tracker matching can
    use an exact === comparison. Returns None if no recognizable id.
    """
    if not source_url:
        return None
    m = re.search(r'[?&]v=([\w-]{6,})', source_url)
    if m: return m.group(1)
    m = re.search(r'youtu\.be/([\w-]{6,})', source_url)
    if m: return m.group(1)
    m = re.search(r'/shorts/([\w-]{6,})', source_url, re.IGNORECASE)
    if m: return m.group(1)
    m = re.search(r'status/(\d{6,})', source_url)
    if m: return 'tw' + m.group(1)
    return None


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


def pick_stem_files(files_in_folder):
    """Mirror scanStems' pickStem: prefer .m4a over .wav, returns None if neither."""
    fset = set(files_in_folder)
    def pick(name):
        if f'{name}.m4a' in fset: return f'{name}.m4a'
        if f'{name}.wav' in fset: return f'{name}.wav'
        return None
    return {
        'vocals': pick('vocals'),
        'drums':  pick('drums'),
        'bass':   pick('bass'),
        'guitar': pick('guitar'),
        'piano':  pick('piano'),
        'other':  pick('other'),
        'rhythm': pick('bass+drums'),
        'source': pick('source'),
    }


def scan_per_folder_loops(files_in_folder):
    """Mirror scanStems' loop detection. Returns (grouped_loops, raw_count)."""
    raw = []
    for f in files_in_folder:
        if 'loop' not in f.lower():
            continue
        m = PER_FOLDER_LOOP_RE.match(f)
        if not m:
            continue
        raw.append({
            'fileName': f,
            'type':     m.group(1).lower(),
            'loopNum':  int(m.group(2)),
            'bars':     int(m.group(3)),
        })
    grouped = {}
    for l in raw:
        g = grouped.setdefault(l['loopNum'], {
            'loopNum': l['loopNum'],
            'bars':    l['bars'],
            'files':   {},
        })
        g['files'][l['type']] = l['fileName']
    return sorted(grouped.values(), key=lambda x: x['loopNum']), len(raw)


def find_logicx(files_in_folder):
    for f in files_in_folder:
        if f.lower().endswith('.logicx'):
            return f
    return None


def fill_gaps(base, stem_dir, meta):
    """Fill ONLY missing fields. Returns (meta, changed_bool)."""
    try:
        import metadata as md
    except ImportError as e:
        print(f"   !! gap-fill skipped — metadata.py deps missing ({e}); "
              "install librosa+soundfile", file=sys.stderr)
        return meta, False

    changed = False
    src = stem_dir / 'source.wav'

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

    # release_date fill via MusicBrainz retired 2026-06-28. fill_gaps now
    # only touches bpm/key (locally via librosa). Anything else the
    # operator wants comes through the Performer's lyrics dialog or
    # manual Google.

    if changed:
        meta['catalog_filled_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        try:
            json.dump(meta, open(stem_dir / 'metadata.json', 'w'),
                      indent=2, ensure_ascii=False)
            open(stem_dir / 'metadata.json', 'a').write('\n')
        except Exception as e:
            print(f"   !! {base}: could not write metadata.json ({e})", file=sys.stderr)
    return meta, changed


def build_stems_row(base, stem_dir, files_in_folder, meta):
    """Match scanStems output in bt-construction-kit/server.js byte-for-byte."""
    stems = pick_stem_files(files_in_folder)
    loops, raw_loop_count = scan_per_folder_loops(files_in_folder)
    practice_bpm = round(meta['bpm']) if isinstance(meta.get('bpm'), (int, float)) else None
    duration = meta.get('duration_sec') if isinstance(meta.get('duration_sec'), (int, float)) else None
    stem_count = sum(1 for v in stems.values() if v)
    return {
        'id': f'stem-{base}',
        'type': 'stems',
        'variantCode': 'STEMS',
        'variantLabel': 'Multitrack Stems',
        'folderName': base,
        'title': meta.get('title') or base.replace('_', ' '),
        'artist': meta.get('artist') or 'Unknown Artist',
        'practiceBpm': practice_bpm,
        'originalBpm': None,
        'key': meta.get('key'),
        'keySignature': meta.get('key_signature'),
        'singer_lead':        meta.get('singer_lead'),
        'singer_backup':      meta.get('singer_backup'),
        'singer_group_vocal': meta.get('singer_group_vocal'),
        'band_required':      meta.get('band_required'),
        'drum_pattern':       meta.get('drum_pattern'),
        'readiness':          meta.get('readiness'),
        'favorite':           bool(meta.get('favorite')),
        'favorited_at':       meta.get('favorited_at'),
        # Source URL + extracted YouTube video ID — used by the portal's
        # ingest tracker to recognize when a submitted URL has landed in
        # the library. Without these the tracker can never trim a row.
        'source_url':         meta.get('source_url'),
        'videoId':            _extract_video_id(meta.get('source_url')),
        # Lyrics — fetched at ingest by lyrics_fetch.py. lyrics_chunks is
        # the section-split form ({label, text}[]); lyrics is the full
        # flat text as a fallback. Both null when Genius had no match.
        'lyrics':             meta.get('lyrics'),
        'lyrics_chunks':      meta.get('lyrics_chunks'),
        'stems': stems,
        'cached': False,
        'logicProjectName': find_logicx(files_in_folder),
        'loops': loops,
        'duration': duration,
        'stats': {
            'stemCount': stem_count,
            'loopCount': raw_loop_count,
        },
    }


def variant_for(file_name):
    """Strip variant suffix from M4A/<file>.m4a basename, return (stripped, code, label)."""
    base_name = file_name[:-4]  # drop .m4a
    for pat, code, label in VARIANT_PATTERNS:
        if pat.search(base_name):
            return pat.sub('', base_name), code, label
    return base_name, 'FULL', 'Full Mix'


def build_m4a_rows(m4a_root, stems_by_base):
    """Match scanM4a output in bt-construction-kit/server.js."""
    rows = []
    if not m4a_root.exists():
        return rows
    files = sorted([f.name for f in m4a_root.iterdir()
                    if f.is_file() and f.name.lower().endswith('.m4a')])
    for fname in files:
        if DRIVE_DUP_M4A_RE.search(fname): continue
        if LOOP_M4A_RE.search(fname): continue
        stripped, variant_code, variant_label = variant_for(fname)
        sib = stems_by_base.get(stripped)
        title    = sib['title']        if sib else stripped.replace('_', ' ')
        artist   = sib['artist']       if sib else 'Unknown Artist'
        bpm      = sib['practiceBpm']  if sib else None
        key      = sib['key']          if sib else None
        key_sig  = sib['keySignature'] if sib else None
        duration = sib['duration']     if sib else None
        rows.append({
            'id': f'm4a-{fname}',
            'type': 'm4a',
            'fileName': fname,
            'title': title,
            'artist': artist,
            'practiceBpm': bpm,
            'originalBpm': None,
            'key': key,
            'keySignature': key_sig,
            'duration': duration,
            'cached': False,
            'variantCode': variant_code,
            'variantLabel': variant_label,
        })
    return rows


def _norm(s):
    return re.sub(r'\s+', ' ', (s or '').lower()).strip()


def pick_unique_songs(rows):
    """Group by (title, artist); prefer stems over m4a. Matches pickUniqueSongs in JS."""
    by_key = {}
    for r in rows:
        k = f"{_norm(r.get('title'))}|{_norm(r.get('artist'))}"
        prev = by_key.get(k)
        if not prev:
            by_key[k] = r
        elif prev.get('type') != 'stems' and r.get('type') == 'stems':
            by_key[k] = r
    return list(by_key.values())


def compute_stats(all_rows, stem_rows, m4a_rows):
    uniques = pick_unique_songs(all_rows)
    bpm_dist = {'slow': 0, 'medium': 0, 'fast': 0, 'unknown': 0}
    key_dist = {}
    for s in uniques:
        bpm = s.get('practiceBpm')
        if not bpm:
            bpm_dist['unknown'] += 1
        elif bpm < 90:
            bpm_dist['slow'] += 1
        elif bpm <= 125:
            bpm_dist['medium'] += 1
        else:
            bpm_dist['fast'] += 1
        k = s.get('key')
        if k:
            key_dist[k] = key_dist.get(k, 0) + 1
    artists = {s.get('artist') for s in uniques
               if s.get('artist') and s.get('artist') != 'Unknown Artist'}
    return {
        'totalSongs':  len(uniques),
        'totalFiles':  len(all_rows),
        'totalStems':  len(stem_rows),
        'totalM4as':   len(m4a_rows),
        'artistCount': len(artists),
        'bpmDistribution': bpm_dist,
        'keyDistribution': key_dist,
    }


def _dir_mtime_iso(d):
    try:
        return datetime.fromtimestamp(d.stat().st_mtime, tz=timezone.utc) \
            .strftime('%Y-%m-%dT%H:%M:%S.000Z')
    except Exception:
        return None


def build(root, do_fill):
    # M4A mixdowns retired 2026-06-27 — the portal mixes the six stems
    # client-side. catalog.py now only walks STEMS/. The build_m4a_rows /
    # m4a drift logic is gone; if M4A/ exists from a pre-purge era, it is
    # ignored by the catalog and will be moved aside by
    # retire_legacy_files.sh.
    stems_root = root / 'STEMS'

    drift = {
        'stems_without_metadata': [],
        'metadata_without_stems': [],
        'incomplete':             [],
    }

    stem_rows = []
    if stems_root.exists():
        dirs = sorted([d for d in stems_root.iterdir() if d.is_dir()])
        for d in dirs:
            base = d.name
            if DRIVE_DUP_DIR_RE.search(base):
                continue
            try:
                files = os.listdir(d)
            except Exception as e:
                print(f"   !! {d}: unreadable ({e})", file=sys.stderr)
                continue
            meta = load_metadata(d)
            if not meta:
                drift['stems_without_metadata'].append(base)
            if do_fill and meta:
                meta, _ = fill_gaps(base, d, meta)
            row = build_stems_row(base, d, files, meta)
            if row['stats']['stemCount'] == 0 and meta:
                drift['metadata_without_stems'].append(base)
            if row['stats']['stemCount'] < len(EXPECTED_STEMS):
                drift['incomplete'].append(base)
            stem_rows.append(row)

    all_rows = stem_rows
    stats = compute_stats(all_rows, stem_rows, [])

    payload = {
        'scannedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
        'sourceMtimes': {
            'stems': _dir_mtime_iso(stems_root),
        },
        'data': {
            'stats': stats,
            'songs': all_rows,
        },
    }
    return payload, drift


def print_drift(drift, n_rows, n_stems):
    print(f"\n== catalog: {n_rows} stems rows")
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
    payload, drift = build(args.root, do_fill=not args.no_fill)

    songs = payload['data']['songs']
    n_rows = len(songs)
    n_stems = sum(1 for r in songs if r['type'] == 'stems')

    if not args.report_only:
        out = args.root / 'CATALOG.json'
        json.dump(payload, open(out, 'w'), indent=2, ensure_ascii=False)
        open(out, 'a').write('\n')
        print(f">> wrote {out.name} ({n_rows} stems rows)")

    print_drift(drift, n_rows, n_stems)


if __name__ == '__main__':
    main()
