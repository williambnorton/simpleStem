#!/usr/bin/env python3
"""faststart_m4a.py — Rewrite every m4a in the library so the moov atom
sits at the FRONT of the file. Without this, Chrome's <audio> decoder
stalls because it has to download the whole file before finding the
codec spec.

Python replacement for the shell version. Reliable because it gives
each ffmpeg call a real /dev/null stdin via subprocess, so ffmpeg
cannot steal bytes from the script's input loop.

Usage:
    ./faststart_m4a.py                 # dry run
    ./faststart_m4a.py --go            # actually rewrite
    ./faststart_m4a.py --go STEMS      # only STEMS
    ./faststart_m4a.py --go --workers 4   # parallel
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("SIMPLE_STEM_ROOT") or Path.home() / "ClaudeDrive" / "simpleStem")
SCOPES_ALL = ["STEMS", "DRUM_MACHINE", "CUSTOM_LOOPS"]


def scan_head(path: Path, n: int = 256 * 1024) -> bytes:
    """Read the first n bytes of a file. Empty bytes on any error."""
    try:
        with path.open("rb") as fh:
            return fh.read(n)
    except OSError:
        return b""


def needs_rewrite(path: Path) -> bool:
    """True if EITHER condition holds:
      (a) moov is NOT in the first 256 KB (moov at the back), OR
      (b) the ftyp box doesn't include the mp42 brand (Chrome's <audio>
          element rejects audio/mp4 without mp42).
    """
    head = scan_head(path)
    if b"moov" not in head:
        return True
    # ftyp box starts at offset 4 (`ftyp` literal). Major brand is the
    # next 4 bytes, then 4 bytes minor version, then the compatible
    # brands list runs until the box size ends. Cheap check: just
    # search the first 32 bytes for b'mp42'.
    return b"mp42" not in head[:32]


def rewrite_one(path: Path) -> tuple[bool, str]:
    """ffmpeg-remux path with +faststart AND -brand mp42. Returns (ok, msg).

    The -brand mp42 flag rewrites the ftyp box so the major brand is
    mp42 instead of M4A. Chrome's <audio> decoder is strict about
    this — empirically, audio/mp4 files with ftyp M4A/isom/iso2 fail
    to decode (loadstart fires, then stalled at 3s, no metadata, no
    canplay). Same bytes with ftyp mp42/isomiso2 decode normally.
    Drum machine files (which were created by a different toolchain
    that included mp42 brand) play fine even when they had moov at
    the end; that's how we noticed the difference.

    ffmpeg's stdin is pinned to DEVNULL via subprocess so it CANNOT
    enter interactive mode and steal bytes from another stream.
    """
    tmp = path.with_suffix(".tmp.m4a")
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-y", "-v", "error",
                "-i", str(path),
                "-c", "copy",
                "-movflags", "+faststart",
                "-brand", "mp42",
                str(tmp),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            return False, f"ffmpeg rc={result.returncode}: {result.stderr.decode(errors='replace').strip()[:200]}"
        if not tmp.exists() or tmp.stat().st_size == 0:
            tmp.unlink(missing_ok=True)
            return False, "tmp file missing or empty"
        # Atomic-ish swap: rename over the original (POSIX rename is atomic on same FS).
        os.replace(tmp, path)
        return True, ""
    except subprocess.TimeoutExpired:
        tmp.unlink(missing_ok=True)
        return False, "ffmpeg timed out (>120s)"
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return False, f"exception: {e}"


def gather_files(scopes: list[str]) -> list[Path]:
    files: list[Path] = []
    for scope in scopes:
        scope_dir = ROOT / scope
        if not scope_dir.is_dir():
            print(f"  {scope}: directory missing, skipping.", file=sys.stderr)
            continue
        for p in scope_dir.rglob("*.m4a"):
            if p.name.endswith(".tmp.m4a"):
                continue
            if ".retired" in p.parts:
                continue
            files.append(p)
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scopes", nargs="*", default=None,
                    help="Directories to scan (default: STEMS DRUM_MACHINE CUSTOM_LOOPS)")
    ap.add_argument("--go", action="store_true", help="Actually rewrite (otherwise dry run)")
    ap.add_argument("--workers", type=int, default=2,
                    help="Parallel ffmpeg processes (default: 2; SSDs handle 4 well)")
    ap.add_argument("--quiet", action="store_true", help="Skip per-file output")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        print("ffmpeg not found in PATH.", file=sys.stderr)
        return 1
    if not ROOT.is_dir():
        print(f"Root not found: {ROOT}", file=sys.stderr)
        return 1

    scopes = args.scopes if args.scopes else SCOPES_ALL
    bad = [s for s in scopes if s not in SCOPES_ALL]
    if bad:
        print(f"Unknown scopes: {bad}. Allowed: {SCOPES_ALL}", file=sys.stderr)
        return 1

    print(f"Root:    {ROOT}")
    print(f"Scopes:  {' '.join(scopes)}")
    print(f"Mode:    {'EXECUTE' if args.go else 'DRY RUN'}")
    print(f"Workers: {args.workers}")
    print()

    print("Scanning...", flush=True)
    all_files = gather_files(scopes)
    print(f"  found {len(all_files)} .m4a files (excluding .retired)")

    needs: list[Path] = []
    already = 0
    for f in all_files:
        if needs_rewrite(f):
            needs.append(f)
        else:
            already += 1
    print(f"  needs rewrite: {len(needs)}")
    print(f"  already fast:  {already}")
    print()

    if not args.go:
        if needs:
            print("Sample of files that would be rewritten:")
            for f in needs[:10]:
                print(f"  needs: {f.relative_to(ROOT)}")
            if len(needs) > 10:
                print(f"  ... and {len(needs) - 10} more")
        print("\n(dry run — re-run with --go to actually rewrite)")
        return 0

    print(f"Rewriting {len(needs)} files with {args.workers} workers...")
    done = 0
    rewrote = 0
    failed = 0
    fail_examples: list[tuple[Path, str]] = []
    t_start = time.monotonic()
    # Canonical progress line per CLAUDE.md: timestamp + script name +
    # N/total + counts + ETA. Emit every PROGRESS_EVERY_FILES files AND
    # at least every PROGRESS_EVERY_SECONDS so a quiet stretch (e.g. one
    # slow ffmpeg) still produces a heartbeat in the log.
    PROGRESS_EVERY_FILES = 50
    PROGRESS_EVERY_SECONDS = 30 * 60  # 30 minutes
    last_progress_t = t_start

    def fmt_eta(seconds: float) -> str:
        if seconds < 0 or seconds != seconds:  # nan
            return "?"
        seconds = int(seconds)
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        if h: return f"{h}h {m:02d}m"
        if m: return f"{m}m {s:02d}s"
        return f"{s}s"

    def emit_progress():
        ts = datetime.datetime.now().astimezone().strftime("%a %b %d %H:%M:%S %Z %Y")
        elapsed = time.monotonic() - t_start
        rate = done / elapsed if elapsed > 0 else 0
        remaining = (len(needs) - done) / rate if rate > 0 else float("inf")
        print(
            f"{ts}  faststart_m4a.py  "
            f"progress: {done}/{len(needs)} "
            f"({rewrote} ok, {failed} failed) — "
            f"ETA ~{fmt_eta(remaining)} remaining "
            f"@ {rate:.1f} files/sec",
            flush=True,
        )

    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(rewrite_one, f): f for f in needs}
        for fut in cf.as_completed(futures):
            f = futures[fut]
            done += 1
            try:
                ok, msg = fut.result()
            except Exception as e:
                ok, msg = False, f"future exception: {e}"
            if ok:
                rewrote += 1
                if not args.quiet:
                    print(f"  [{done}/{len(needs)}] ok: {f.relative_to(ROOT)}")
            else:
                failed += 1
                if len(fail_examples) < 20:
                    fail_examples.append((f, msg))
                print(f"  [{done}/{len(needs)}] FAIL: {f.relative_to(ROOT)} — {msg}", file=sys.stderr)

            now = time.monotonic()
            if (done % PROGRESS_EVERY_FILES == 0) or (now - last_progress_t >= PROGRESS_EVERY_SECONDS):
                emit_progress()
                last_progress_t = now

    # Final progress line so the user sees the finish stamp even if the
    # last batch didn't trigger the periodic emit.
    emit_progress()

    print()
    print("=== summary ===")
    print(f"  needed rewrite:  {len(needs)}")
    print(f"  rewrote ok:      {rewrote}")
    print(f"  failed:          {failed}")
    if fail_examples:
        print("\nFirst few failures (for triage):")
        for f, m in fail_examples[:5]:
            print(f"  {f.relative_to(ROOT)}: {m}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
