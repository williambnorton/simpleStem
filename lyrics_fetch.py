#!/usr/bin/env python3
"""
lyrics_fetch.py — Librarian-side lyrics ingester.

Given a title + artist, fetches lyrics from Genius via the `lyricsgenius`
library and parses them into section chunks (Verse 1, Chorus, Bridge…)
from Genius's `[Section Name]` headers. Writes the result into the
song's metadata.json next to the existing fields. Skips songs whose
metadata already has lyrics so re-running is a cheap no-op.

This lives on the Librarian, runs at ingest time alongside metadata.py,
and stores everything locally — the Performer reads lyrics from
metadata.json at gig time with NO internet required.

Usage:
    lyrics_fetch.py --dir STEMS/<base>                 # single song
    lyrics_fetch.py --all                              # backfill every STEMS dir
    lyrics_fetch.py --dir STEMS/<base> --force         # overwrite existing lyrics
    lyrics_fetch.py --token GENIUS_TOKEN ...           # explicit token

Genius API token: GENIUS_ACCESS_TOKEN env var, or --token flag, or
~/.simpleStem-genius-token file (one line). Get a free token at:
    https://genius.com/api-clients

Exit codes:
  0 — wrote lyrics OR already had them OR no match found (non-fatal)
  1 — bad arguments / no token / unreadable metadata.json
  2 — partial failure on --all (some songs failed)
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    import lyricsgenius
except ImportError:
    sys.stderr.write(
        "Missing lyricsgenius. Install with:\n"
        "  pip install --break-system-packages lyricsgenius\n"
    )
    sys.exit(1)


def load_token(cli_token):
    """Resolve the Genius API token from CLI, env, or ~/.simpleStem-genius-token."""
    if cli_token:
        return cli_token.strip()
    env = os.environ.get('GENIUS_ACCESS_TOKEN')
    if env:
        return env.strip()
    tok_file = Path.home() / '.simpleStem-genius-token'
    if tok_file.exists():
        return tok_file.read_text().strip().splitlines()[0]
    return None


# Genius wraps section headers in [brackets]. Splitting on those gives
# us labeled chunks. A common pattern looks like:
#
#   [Verse 1]
#   Mama, just killed a man
#   Put a gun against his head…
#
#   [Chorus]
#   Mama, life had just begun…
#
# Some songs use [Verse 1: Name] or [Pre-Chorus]; the regex is loose.
SECTION_RE = re.compile(r'^\s*\[([^\]]+)\]\s*$', re.MULTILINE)


def chunk_lyrics(text):
    """Split a Genius-formatted lyrics string into [{label, text}] chunks.

    Returns at least one chunk even if no section markers are present —
    falls back to a single "Lyrics" block so the downstream action still
    has something to show.
    """
    if not text:
        return []
    text = text.strip()
    # Drop the Genius footer noise: "5Embed", "12Embed", "You might also
    # like" etc. The library often appends them.
    text = re.sub(r'\d+Embed\s*$', '', text).strip()
    text = re.sub(r'You might also like\s*$', '', text, flags=re.MULTILINE).strip()

    matches = list(SECTION_RE.finditer(text))
    if not matches:
        return [{'label': 'Lyrics', 'text': text}]

    chunks = []
    # If text before the first [Section] header has content, include it
    # as an "Intro" / preamble chunk.
    if matches[0].start() > 0:
        pre = text[: matches[0].start()].strip()
        if pre:
            chunks.append({'label': 'Intro', 'text': pre})
    for i, m in enumerate(matches):
        label = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if body:
            chunks.append({'label': label, 'text': body})
    return chunks


def fetch_for(genius, title, artist):
    """Look up lyrics on Genius. Returns (lyrics_text, error_str). Either may
    be None — success returns text + None, miss returns None + reason."""
    if not title:
        return None, 'no title in metadata.json'
    try:
        song = genius.search_song(title, artist or '')
    except Exception as e:
        return None, f'genius lookup failed: {e}'
    if not song:
        return None, 'no Genius match'
    return song.lyrics, None


def update_song(stem_dir, genius, force=False):
    """Process one STEMS/<base>/. Returns (status, msg):
       status ∈ {'wrote', 'skip-existing', 'skip-no-meta', 'miss', 'error'}.
    """
    meta_path = Path(stem_dir) / 'metadata.json'
    if not meta_path.exists():
        return 'skip-no-meta', f'no metadata.json in {stem_dir}'
    try:
        meta = json.loads(meta_path.read_text())
    except Exception as e:
        return 'error', f'bad metadata.json: {e}'
    if meta.get('lyrics') and not force:
        return 'skip-existing', 'already has lyrics'

    title = meta.get('title') or stem_dir.name.replace('_', ' ')
    artist = meta.get('artist') or 'Unknown'
    text, err = fetch_for(genius, title, artist)
    if not text:
        return 'miss', err or 'unknown'

    chunks = chunk_lyrics(text)
    meta['lyrics'] = text.strip()
    meta['lyrics_chunks'] = chunks
    meta['lyrics_source'] = 'genius'
    meta['lyrics_fetched_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + '\n')
    return 'wrote', f'{len(chunks)} chunks'


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--dir', type=Path, help='Single STEMS/<base> directory to update')
    g.add_argument('--all', action='store_true', help='Process every STEMS/<base> directory')
    p.add_argument('--root', type=Path, default=None, help='simpleStem root (default ~/ClaudeDrive/simpleStem)')
    p.add_argument('--token', help='Genius API token (else GENIUS_ACCESS_TOKEN or ~/.simpleStem-genius-token)')
    p.add_argument('--force', action='store_true', help='Overwrite existing lyrics fields')
    p.add_argument('--quiet', action='store_true', help='Only print failures + summary')
    args = p.parse_args()

    token = load_token(args.token)
    if not token:
        sys.stderr.write(
            'No Genius API token. Get one free at https://genius.com/api-clients\n'
            'Then either:\n'
            '  - export GENIUS_ACCESS_TOKEN=...\n'
            '  - echo TOKEN > ~/.simpleStem-genius-token\n'
            '  - --token TOKEN\n'
        )
        sys.exit(1)

    genius = lyricsgenius.Genius(token, verbose=False, remove_section_headers=False, timeout=10)
    # Keep section headers in the returned lyrics so chunk_lyrics() can
    # find the [Verse 1] / [Chorus] markers. Cut chatty noise.
    genius.skip_non_songs = True

    root = args.root or Path.home() / 'ClaudeDrive' / 'simpleStem'
    stems = root / 'STEMS'

    if args.dir:
        dirs = [args.dir.resolve()]
    else:
        dirs = sorted([d for d in stems.iterdir() if d.is_dir() and not d.name.endswith(')')])

    counts = {'wrote': 0, 'skip-existing': 0, 'skip-no-meta': 0, 'miss': 0, 'error': 0}
    for d in dirs:
        status, msg = update_song(d, genius, force=args.force)
        counts[status] += 1
        if status == 'wrote' and not args.quiet:
            print(f'  wrote: {d.name} ({msg})')
        elif status in ('miss', 'error'):
            print(f'  {status}: {d.name} ({msg})', file=sys.stderr)

    print(
        f'\nDone. wrote={counts["wrote"]} '
        f'skip-existing={counts["skip-existing"]} '
        f'skip-no-meta={counts["skip-no-meta"]} '
        f'miss={counts["miss"]} '
        f'error={counts["error"]}'
    )
    sys.exit(0 if counts['error'] == 0 else 2)


if __name__ == '__main__':
    main()
