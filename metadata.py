#!/usr/bin/env python3
"""
Write metadata.json into a song folder.

Combines:
  - Known facts (title, artist, source URL, processing date)
  - Detected facts (BPM, key, key signature, version flag)
  - Useful search links (Google lyrics, Ultimate Guitar chords)
  - (MusicBrainz release-date lookup retired 2026-06-28 — Bill uses
    the Performer's lyrics dialog + manual Google searches instead.)

Usage:
    metadata.py --dir SONG_DIR --title TITLE --artist ARTIST [--url URL]
                [--info-json PATH] [--force]

Reads:
    SONG_DIR/source.wav      — for BPM + key detection
    --info-json PATH         — yt-dlp .info.json (upload date, true title, etc.)

Writes:
    SONG_DIR/metadata.json

Idempotent: skips if metadata.json already exists, unless --force is given.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf


# Krumhansl-Kessler key profiles (standard reference for tonal music)
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                     2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                     2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Map "<tonic> <mode>" → conventional key signature.
# (Includes both sharp and flat spellings where it matters.)
KEY_SIGNATURE = {
    'C major':  '0 sharps/flats',     'A minor':  '0 sharps/flats',
    'G major':  '1 sharp',            'E minor':  '1 sharp',
    'D major':  '2 sharps',           'B minor':  '2 sharps',
    'A major':  '3 sharps',           'F# minor': '3 sharps',
    'E major':  '4 sharps',           'C# minor': '4 sharps',
    'B major':  '5 sharps',           'G# minor': '5 sharps',
    'F# major': '6 sharps',           'D# minor': '6 sharps',
    'F major':  '1 flat',             'D minor':  '1 flat',
    'A# major': '2 flats',            'G minor':  '2 flats',  # A#=Bb
    'D# major': '3 flats',            'C minor':  '3 flats',  # D#=Eb
    'G# major': '4 flats',            'F minor':  '4 flats',  # G#=Ab
    'C# major': '5 flats',            'A# minor': '5 flats',  # C#=Db, A#=Bb
}


def detect_bpm_key(wav_path):
    """Returns (bpm, key_str) where key_str is like 'C major'."""
    y, sr = sf.read(str(wav_path), always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    y = y.astype(np.float32)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])  # may be scalar or 1-d array

    # Krumhansl-Schmuckler key estimation: correlate mean chroma against
    # rotated major/minor profiles; pick the rotation/mode with highest r.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    best = ('major', 'C', -1.0)
    for shift in range(12):
        rotated = np.roll(chroma_mean, -shift)
        rmaj = float(np.corrcoef(rotated, KS_MAJOR)[0, 1])
        rmin = float(np.corrcoef(rotated, KS_MINOR)[0, 1])
        if rmaj > best[2]:
            best = ('major', NOTES[shift], rmaj)
        if rmin > best[2]:
            best = ('minor', NOTES[shift], rmin)
    mode, tonic, _ = best
    return bpm, f"{tonic} {mode}"


def classify_version(title):
    """Tag the YouTube title as one of: live, official, cover, karaoke, studio."""
    t = title.lower()
    if 'live' in t or 'concert' in t:
        return 'live'
    if 'cover' in t or 'tribute' in t:
        return 'cover'
    if 'karaoke' in t:
        return 'karaoke'
    if 'official audio' in t or 'official music video' in t or 'official video' in t:
        return 'official'
    return 'studio'  # default assumption when nothing else matches


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, type=Path,
                    help="song folder containing source.wav")
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--url", default="", help="source URL (e.g., YouTube)")
    ap.add_argument("--info-json", type=Path,
                    help="yt-dlp .info.json with upload date / actual title")
    ap.add_argument("--duration", type=float, default=None,
                    help="override duration_sec (e.g. a per-chapter slice length)")
    ap.add_argument("--clip-start", type=float, default=None, dest='clip_start',
                    help="start offset (sec) of this song within the source video")
    ap.add_argument("--force", action='store_true')
    args = ap.parse_args()

    meta_path = args.dir / 'metadata.json'
    if meta_path.exists() and not args.force:
        print(f">> {meta_path.name} already present (use --force to overwrite)")
        return

    src = args.dir / 'source.wav'
    if not src.exists():
        print(f"!! {src} not found; skipping metadata", file=sys.stderr)
        return

    print(">> Detecting BPM + key…")
    bpm, key = detect_bpm_key(src)
    key_sig = KEY_SIGNATURE.get(key, 'unknown')

    yt_title = args.title
    yt_uploader = None
    yt_upload_date = None
    yt_duration = None
    url = args.url
    if args.info_json and args.info_json.exists():
        with open(args.info_json) as f:
            info = json.load(f)
        yt_title = info.get('title') or args.title
        yt_uploader = info.get('uploader')
        ud = info.get('upload_date')
        if ud and len(ud) == 8 and ud.isdigit():
            yt_upload_date = f"{ud[:4]}-{ud[4:6]}-{ud[6:8]}"
        yt_duration = info.get('duration')
        if not url:
            url = info.get('webpage_url') or ''

    if args.duration is not None:
        yt_duration = int(round(args.duration))

    # Clip window inside the source video. Set for songs carved out of a
    # chaptered "full album" upload (download the whole video, slice this
    # range); None for a standalone video (download the whole thing).
    clip_start = args.clip_start
    clip_end = None
    if clip_start is not None and yt_duration is not None:
        clip_end = round(clip_start + yt_duration, 3)

    print(">> Classifying version (live/studio/official/cover/karaoke)…")
    version = classify_version(yt_title)

    # release_date is left null on new ingests — the MusicBrainz lookup was
    # retired 2026-06-28. Existing songs keep whatever release_date they
    # already had in metadata.json.
    release_date = None

    lyrics_url = ("https://www.google.com/search?q=" +
                  urllib.parse.quote(f'{args.artist} {args.title} lyrics'))
    chords_url = ("https://www.ultimate-guitar.com/search.php"
                  "?search_type=title&value=" +
                  urllib.parse.quote(f'{args.title} {args.artist}'))

    # Self-contained recipe for the downstream pipeline: pull 48 kHz audio
    # (slicing the clip window if set), separate into 6 stems with Demucs, and
    # render the four m4a mixdowns. "minus" mixes phase-invert the listed stems
    # and sum them onto the source; "only" keeps just the listed stems.
    processing = {
        'download': {
            'tool': 'yt-dlp',
            'source_url': url,
            'audio_format': 'bestaudio',
            'target_sample_rate_hz': 48000,
            'output': 'source.wav',
            'clip_start_sec': clip_start,
            'clip_end_sec': clip_end,
        },
        'separation': {
            'tool': 'demucs',
            'model': 'htdemucs_6s',
            'stems': ['vocals', 'drums', 'bass', 'other', 'piano', 'guitar'],
        },
        'mixdowns': {
            'format': {'codec': 'aac', 'container': 'm4a',
                       'bitrate': '256k', 'sample_rate_hz': 48000},
            'outputs': [
                {'suffix': '-V',     'method': 'minus', 'stems': ['vocals']},
                {'suffix': '-V-G',   'method': 'minus', 'stems': ['vocals', 'guitar']},
                {'suffix': '-V-G-B', 'method': 'minus', 'stems': ['vocals', 'guitar', 'bass']},
                {'suffix': 'DO',     'method': 'only',  'stems': ['drums']},
            ],
        },
    }

    metadata = {
        'title': args.title,
        'artist': args.artist,
        'youtube_title': yt_title,
        'youtube_uploader': yt_uploader,
        'youtube_upload_date': yt_upload_date,
        'release_date': release_date,
        'source_url': url,
        'version': version,
        'duration_sec': yt_duration,
        'clip_start_sec': clip_start,
        'clip_end_sec': clip_end,
        'bpm': round(bpm, 1),
        'key': key,
        'key_signature': key_sig,
        'lyrics_search_url': lyrics_url,
        'chords_search_url': chords_url,
        'processing': processing,
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f">> wrote {meta_path.name}: {bpm:.1f} BPM, {key} ({key_sig}), {version}")


if __name__ == "__main__":
    main()
