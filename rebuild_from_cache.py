#!/usr/bin/env python3
"""Rebuild Drive STEMS folders from the Performer's local stem cache.

2026-08-09: disk-full pressure made Google Drive drop a batch of
STEMS/<slug>/ folders (11+ songs vanished from the library). Their six
m4a stems survived in ~/.bt-cache/STEMS/. This script copies them back
into the Drive folder and synthesizes a minimal metadata.json so the
Librarian's next catalog pass restores the library rows.

Runs on the PERFORMER (the cache lives here). Dry-run by default:

    python3 rebuild_from_cache.py            preview what would be rebuilt
    python3 rebuild_from_cache.py --go       actually copy

Metadata synthesized: title/artist recovered by matching the slug's
tail against every artist already in the catalog mirror (slug-normalized
endswith match, longest artist wins), duration probed from drums.m4a via
afinfo/ffprobe, bpm/key left null (re-analyzable later), and a
rebuilt_from_cache timestamp so these rows are findable.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CACHE_STEMS = os.path.join(HOME, ".bt-cache", "STEMS")
DRIVE_STEMS = os.path.join(HOME, "ClaudeDrive", "simpleStem", "STEMS")
CATALOG_MIRROR = os.path.join(HOME, ".simpleStem-catalog", "CATALOG.json")
STEM_NAMES = {"vocals.m4a", "drums.m4a", "bass.m4a", "guitar.m4a", "piano.m4a", "other.m4a"}
GO = "--go" in sys.argv


def now():
    return time.strftime("%a %b %d %H:%M:%S %Z %Y")


def slugify(s):
    s = s.lower().replace(" ", "_")
    return re.sub(r"[^a-z0-9_-]", "_", s)


def load_artists():
    try:
        with open(CATALOG_MIRROR) as f:
            cat = json.load(f)
        rows = cat.get("songs") or cat.get("rows") or []
        artists = {r.get("artist") for r in rows if r.get("artist")}
        return sorted(artists, key=len, reverse=True)
    except Exception as e:
        print(f"{now()}  rebuild_from_cache  warning: no catalog mirror ({e}) — artist recovery disabled")
        return []


def split_title_artist(folder, artists):
    norm = slugify(folder)
    for artist in artists:
        a = slugify(artist)
        if not a:
            continue
        if norm.endswith("_" + a) or norm == a:
            title_part = folder[: len(folder) - len(a) - 1] if len(folder) > len(a) else ""
            title = re.sub(r"[_]+", " ", title_part).strip(" -_") or folder
            return title, artist
    return re.sub(r"[_]+", " ", folder).strip(), "unknown"


def probe_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if out:
            return round(float(out), 2)
    except Exception:
        pass
    try:
        out = subprocess.run(["afinfo", path], capture_output=True, text=True, timeout=30).stdout
        m = re.search(r"estimated duration:\s*([\d.]+)", out)
        if m:
            return round(float(m.group(1)), 2)
    except Exception:
        pass
    return None


def main():
    if not os.path.isdir(CACHE_STEMS):
        sys.exit(f"cache dir not found: {CACHE_STEMS}")
    if not os.path.isdir(DRIVE_STEMS):
        sys.exit(f"Drive STEMS not found: {DRIVE_STEMS} — is Drive mounted?")

    artists = load_artists()
    drive_have = set(os.listdir(DRIVE_STEMS))
    candidates = []
    for folder in sorted(os.listdir(CACHE_STEMS)):
        src = os.path.join(CACHE_STEMS, folder)
        if not os.path.isdir(src) or folder in drive_have:
            continue
        stems = [f for f in os.listdir(src) if f.lower().endswith(".m4a")]
        if not set(n.lower() for n in stems) & STEM_NAMES:
            continue
        candidates.append((folder, src, stems))

    mode = "GO" if GO else "DRY-RUN"
    print(f"{now()}  rebuild_from_cache  {mode}: {len(candidates)} folder(s) in cache but missing from Drive")
    done = ok = failed = 0
    for folder, src, stems in candidates:
        done += 1
        title, artist = split_title_artist(folder, artists)
        print(f"{now()}  rebuild_from_cache  {done}/{len(candidates)}  {folder}")
        print(f"    -> title '{title}' · artist '{artist}' · {len(stems)} stems")
        if not GO:
            continue
        try:
            dst = os.path.join(DRIVE_STEMS, folder)
            os.makedirs(dst, exist_ok=True)
            for f in stems:
                target = os.path.join(dst, f)
                if not (os.path.exists(target) and os.path.getsize(target) > 0):
                    shutil.copy2(os.path.join(src, f), target)
            meta_path = os.path.join(dst, "metadata.json")
            if not os.path.exists(meta_path):
                probe_src = os.path.join(src, "drums.m4a")
                if not os.path.exists(probe_src) and stems:
                    probe_src = os.path.join(src, stems[0])
                meta = {
                    "title": title,
                    "artist": artist,
                    "source_url": None,
                    "version": "unknown",
                    "duration_sec": probe_duration(probe_src),
                    "bpm": None,
                    "key": None,
                    "key_signature": None,
                    "rebuilt_from_cache": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "processing": {
                        "separation": "htdemucs_6s",
                        "note": "restored from ~/.bt-cache after Drive folder loss; source.wav not recovered",
                    },
                }
                with open(meta_path, "w") as f:
                    json.dump(meta, f, indent=2)
            ok += 1
        except Exception as e:
            failed += 1
            print(f"    !! FAILED: {e}")
    print(f"{now()}  rebuild_from_cache  done: {done} candidates, {ok} rebuilt, {failed} failed ({mode})")
    if not GO and candidates:
        print("re-run with --go to execute")


if __name__ == "__main__":
    main()
