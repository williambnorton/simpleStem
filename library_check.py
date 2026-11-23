#!/usr/bin/env python3
"""
library_check.py — reality checks across the simpleStem song library.

Walks STEMS/<base>/ and prints a suspect table (folder | reasons | url) for
anything that looks like clutter or a mismatched render:

  dup-name       folder name ends in " (1)" — an ingest collision
  dup-url        another folder has the same source_url
  stems-missing  fewer than six stems (lists which)
  stems-tiny     a stem under --min-bytes (truncated encode)
  source-missing no <base>_SOURCE.m4a
  source-tiny    SOURCE.m4a under --min-bytes
  duration       metadata duration_sec, source length and stem length disagree
                 by more than --tolerance seconds (ffprobe, header read only)
  gains-zero     stem_quality fit gains all near 0 — stems unrelated to source
  residual-high  stem_quality residual above --max-residual
  unmeasured     no stem_quality block yet (run stem_quality.py)

Read-only. Nothing is moved or deleted.

Usage (Performer):
    library_check.py                       default library, print suspects
    library_check.py --all                 also list songs that pass
    library_check.py --library <STEMS dir> [--tolerance 2.0] [--max-residual 60]
"""
import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def probe_duration(path: Path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None


def check_song(d: Path, url_index: dict, args) -> list:
    reasons = []
    base = d.name
    if base.endswith(" (1)") or base.endswith(" (2)"):
        reasons.append("dup-name")

    meta = {}
    mp = d / "metadata.json"
    if mp.exists():
        try:
            meta = json.load(open(mp))
        except Exception as e:
            reasons.append(f"metadata-unreadable ({e})")
    else:
        reasons.append("metadata-missing")

    url = meta.get("source_url")
    if url and len(url_index[url]) > 1:
        others = [b for b in url_index[url] if b != base]
        reasons.append("dup-url with " + ", ".join(others))

    missing = [k for k in STEMS if not (d / f"{k}.m4a").exists()]
    if missing:
        reasons.append("stems-missing " + ",".join(missing))
    tiny = [k for k in STEMS if (d / f"{k}.m4a").exists()
            and (d / f"{k}.m4a").stat().st_size < args.min_bytes]
    if tiny:
        reasons.append("stems-tiny " + ",".join(tiny))

    src = d / f"{base}_SOURCE.m4a"
    if not src.exists():
        reasons.append("source-missing")
    elif src.stat().st_size < args.min_bytes:
        reasons.append("source-tiny")

    # duration agreement: metadata vs source vs one stem (header reads only)
    if src.exists() and not missing and not args.no_probe:
        src_len = probe_duration(src)
        stem_len = probe_duration(d / "drums.m4a")
        meta_len = meta.get("duration_sec")
        lens = {"meta": meta_len, "source": src_len, "stems": stem_len}
        have = {k: v for k, v in lens.items() if isinstance(v, (int, float))}
        if len(have) >= 2 and max(have.values()) - min(have.values()) > args.tolerance:
            reasons.append("duration " + " ".join(f"{k}={v:.0f}s" for k, v in have.items()))

    q = meta.get("stem_quality")
    if q:
        gains = q.get("fit_gains", {})
        if gains and all(abs(g) < 0.15 for g in gains.values()):
            reasons.append(f"gains-zero (residual {q.get('residual_pct')}%)")
        elif q.get("residual_pct", 0) > args.max_residual:
            reasons.append(f"residual-high {q.get('residual_pct')}%")
    elif not missing and src.exists():
        reasons.append("unmeasured")
    return reasons


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--library", type=Path, default=Path.home() / "ClaudeDrive" / "simpleStem" / "STEMS")
    ap.add_argument("--tolerance", type=float, default=2.0, help="seconds of duration disagreement allowed")
    ap.add_argument("--max-residual", type=float, default=60.0)
    ap.add_argument("--min-bytes", type=int, default=200_000)
    ap.add_argument("--no-probe", action="store_true", help="skip ffprobe duration checks (faster)")
    ap.add_argument("--all", action="store_true", help="also list songs with no findings")
    args = ap.parse_args()

    songs = sorted(d for d in args.library.iterdir()
                   if d.is_dir() and not d.name.startswith((".", "_")) and d.name != "inbox")

    url_index = defaultdict(list)
    for d in songs:
        mp = d / "metadata.json"
        if mp.exists():
            try:
                u = json.load(open(mp)).get("source_url")
                if u:
                    url_index[u].append(d.name)
            except Exception:
                pass

    suspects = 0
    for d in songs:
        reasons = check_song(d, url_index, args)
        if reasons:
            suspects += 1
            url = ""
            try:
                url = json.load(open(d / "metadata.json")).get("source_url", "")
            except Exception:
                pass
            print(f"{d.name} | {'; '.join(reasons)} | {url}")
        elif args.all:
            print(f"{d.name} | ok |")
    print(f"--- {len(songs)} songs, {suspects} with findings", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
