#!/usr/bin/env python3
"""Strip the retired 'mixdowns' block from every STEMS/*/metadata.json.

The -V / -V-G / -V-G-B / DO mixdown pipeline was retired 2026-06-27; the
portal mixes the six stems client-side. metadata.py stopped emitting the
block on 2026-07-14 (it now writes processing.stem_format instead), and
this one-shot migration removes the remnants from existing files.

Run on the LIBRARIAN (owner of metadata):
    python3 cleanup_mixdown_metadata.py            dry run (default)
    python3 cleanup_mixdown_metadata.py --go       apply

Per-file: removes processing.mixdowns; adds processing.stem_format if the
separation block exists and stem_format doesn't. Writes back with the same
2-space-indent + trailing-newline shape the server uses. Progress lines
carry timestamps per house rules.
"""
import json
import os
import sys
import time

DATA = os.environ.get('SIMPLE_STEM_ROOT',
                      os.path.expanduser('~/ClaudeDrive/simpleStem'))
STEMS = os.path.join(DATA, 'STEMS')
GO = '--go' in sys.argv

STEM_FORMAT = {'codec': 'aac', 'container': 'm4a',
               'bitrate': '256k', 'sample_rate_hz': 48000,
               'faststart': True}


def main():
    dirs = sorted(d for d in os.listdir(STEMS)
                  if os.path.isdir(os.path.join(STEMS, d)))
    total = len(dirs)
    changed = skipped = failed = 0
    t0 = time.time()
    for i, d in enumerate(dirs, 1):
        mp = os.path.join(STEMS, d, 'metadata.json')
        if not os.path.isfile(mp):
            skipped += 1
            continue
        try:
            with open(mp, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            proc = meta.get('processing')
            if not isinstance(proc, dict) or 'mixdowns' not in proc:
                skipped += 1
                continue
            del proc['mixdowns']
            if 'separation' in proc and 'stem_format' not in proc:
                proc['stem_format'] = dict(STEM_FORMAT)
            if GO:
                tmp = mp + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(meta, f, indent=2, ensure_ascii=False)
                    f.write('\n')
                os.replace(tmp, mp)
            changed += 1
            print(f"{'FIXED ' if GO else 'WOULD FIX'}: {d}")
        except Exception as e:
            failed += 1
            print(f"FAILED: {d}: {e}", file=sys.stderr)
        if i % 50 == 0 or i == total:
            rate = i / max(time.time() - t0, 0.001)
            eta = (total - i) / max(rate, 0.001)
            print(f"{time.strftime('%a %b %d %H:%M:%S %Z %Y')}  "
                  f"cleanup_mixdown_metadata.py  progress: {i}/{total} "
                  f"({changed} changed, {skipped} clean, {failed} failed) "
                  f"— ETA ~{int(eta)}s remaining")
    print(f"\n{'APPLIED' if GO else 'DRY RUN'}: {changed} changed, "
          f"{skipped} already clean, {failed} failed of {total} folders.")
    if not GO and changed:
        print("Re-run with --go to apply.")


if __name__ == '__main__':
    main()
