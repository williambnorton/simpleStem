#!/usr/bin/env python3
"""
drum_machine_inventory.py — populate DRUM_MACHINE/ + build PENDING_DRUM_MACHINE.txt

What this does:

  1. Scan STEMS/<song>/metadata.json for every song's drum_pattern field
     (the canonical Drums column from the band's Songlist sheet -- e.g.
     "120@130", "95UduHop", "ACTUAL").
  2. Scan a SOURCE folder of m4a recordings whose filenames embed the
     drum-machine pattern (default: ~/My Drive/m4a files). The pattern
     can appear ANYWHERE in the filename -- prefix, suffix, middle --
     so long as it's a literal `<int>@<int>` token. Whitespace and
     other tokens around it are ignored.
  3. Ensure ~/ClaudeDrive/simpleStem/DRUM_MACHINE/ exists.
  4. For every pattern referenced by at least one song AND found in
     the source folder, copy the m4a there as DRUM_MACHINE/<pattern>.m4a.
     Skipped if already present (idempotent).
  5. Write ~/ClaudeDrive/simpleStem/PENDING_DRUM_MACHINE.txt listing
     every pattern that's referenced by a song but has no recording
     yet, plus which songs reference it. This is Bill's checklist for
     what still needs to be recorded.

Notes:

  - drum_pattern "ACTUAL" means "use the real recording" -- no drum
    machine needed. We skip it in the pending list.
  - Free-form patterns ("95UduHop" etc) won't match the `<n>@<n>`
    extraction from the source folder. Those land in the pending list
    so Bill knows they're outstanding.
  - This script is read-only against STEMS metadata; it never modifies
    a song's metadata.json. Safe to re-run.

Usage:

    python3 bin/drum_machine_inventory.py
    python3 bin/drum_machine_inventory.py --dry-run

Both ~/ClaudeDrive/simpleStem and ~/My Drive/m4a files paths are
overridable via env vars SIMPLE_STEM_ROOT and DRUM_M4A_SOURCE.
"""

import argparse
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# Canonical pattern matcher: one or more digits, an @, one or more digits.
# We match it greedily anywhere in the filename. The whole filename is
# considered (e.g. "Heroes-David Bowie 120@130.m4a" -> "120@130").
PATTERN_RE = re.compile(r"(\d+@\d+)")

# Tokens in the Drums column that mean "no recording needed" -- skip them
# in the pending list rather than nagging Bill to record something that
# doesn't exist.
SKIP_TOKENS = {"ACTUAL", "TBD", "tbd", "actual", ""}


def find_source_root() -> Path:
    env = os.environ.get("DRUM_M4A_SOURCE")
    if env:
        return Path(env).expanduser()
    return Path.home() / "My Drive" / "m4a files"


def find_stem_root() -> Path:
    env = os.environ.get("SIMPLE_STEM_ROOT")
    if env:
        return Path(env).expanduser()
    return Path.home() / "ClaudeDrive" / "simpleStem"


def collect_patterns_from_metadata(stems_dir: Path):
    """Walk STEMS/<song>/metadata.json. Return {pattern: [(title, artist, base)]}."""
    by_pattern = defaultdict(list)
    songs_without_pattern = 0
    songs_with_pattern = 0
    if not stems_dir.is_dir():
        print(f"[error] STEMS dir not found: {stems_dir}", file=sys.stderr)
        sys.exit(2)
    for base_dir in sorted(stems_dir.iterdir()):
        if not base_dir.is_dir():
            continue
        meta_path = base_dir / "metadata.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except Exception as e:
            print(f"[warn] {base_dir.name}: unparseable metadata.json ({e})")
            continue
        dp = (meta.get("drum_pattern") or "").strip()
        if not dp or dp in SKIP_TOKENS:
            songs_without_pattern += 1
            continue
        songs_with_pattern += 1
        title = meta.get("title") or base_dir.name
        artist = meta.get("artist") or ""
        by_pattern[dp].append((title, artist, base_dir.name))
    return by_pattern, songs_with_pattern, songs_without_pattern


def index_source_m4as(source_dir: Path):
    """Walk source m4a folder. Return {pattern: source_path}.

    If multiple files contain the same pattern token (e.g. two recordings
    of 120@130 for different songs), we keep the LAST one alphabetically
    -- they're presumed to be equivalent patterns and the consumer doesn't
    care which version it gets. A warning is printed for transparency."""
    by_pattern = {}
    collisions = defaultdict(list)
    if not source_dir.is_dir():
        print(f"[warn] source m4a folder not found: {source_dir}")
        return by_pattern
    for path in sorted(source_dir.iterdir()):
        if not path.is_file() or path.suffix.lower() != ".m4a":
            continue
        m = PATTERN_RE.search(path.stem)
        if not m:
            continue
        pat = m.group(1)
        if pat in by_pattern:
            collisions[pat].append(path.name)
        by_pattern[pat] = path
    for pat, others in collisions.items():
        print(f"[note] pattern {pat} has multiple source files; kept {by_pattern[pat].name}; "
              f"ignored: {', '.join(others)}")
    return by_pattern


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="report what would happen without copying or writing files")
    args = ap.parse_args()

    stem_root = find_stem_root()
    source_dir = find_source_root()
    drum_dir = stem_root / "DRUM_MACHINE"
    pending_file = stem_root / "PENDING_DRUM_MACHINE.txt"
    stems_dir = stem_root / "STEMS"

    print(f"[config] simpleStem root: {stem_root}")
    print(f"[config] source m4a dir:  {source_dir}")
    print(f"[config] DRUM_MACHINE:    {drum_dir}")
    print(f"[config] pending list:    {pending_file}")
    print(f"[config] dry-run:         {args.dry_run}")
    print()

    print("[1/4] scanning STEMS metadata for drum_pattern values...")
    by_pattern, with_pat, without_pat = collect_patterns_from_metadata(stems_dir)
    print(f"       {with_pat} songs reference a drum pattern, {without_pat} have none/ACTUAL/empty")
    print(f"       {len(by_pattern)} unique patterns referenced")
    print()

    print("[2/4] indexing source m4a folder for available recordings...")
    available = index_source_m4as(source_dir)
    print(f"       {len(available)} unique <N@N> patterns found in source folder")
    print()

    if not args.dry_run:
        drum_dir.mkdir(parents=True, exist_ok=True)

    print("[3/4] populating DRUM_MACHINE/ ...")
    copied = []
    skipped_present = []
    no_source_for_pattern = []
    for pat in sorted(by_pattern):
        target = drum_dir / f"{pat}.m4a"
        if target.exists():
            skipped_present.append(pat)
            continue
        src = available.get(pat)
        if not src:
            no_source_for_pattern.append(pat)
            continue
        if args.dry_run:
            print(f"       [dry] would copy {src.name} -> DRUM_MACHINE/{pat}.m4a")
        else:
            shutil.copy2(src, target)
            print(f"       copied {src.name} -> DRUM_MACHINE/{pat}.m4a")
        copied.append(pat)

    print(f"       {len(copied)} copied · {len(skipped_present)} already present · "
          f"{len(no_source_for_pattern)} pattern(s) referenced but no source m4a")
    print()

    # Pending list — every referenced pattern that doesn't have a file in
    # DRUM_MACHINE yet AFTER the copy pass. The list groups by pattern and
    # shows which songs are waiting on each one. Recording one m4a may
    # satisfy multiple songs.
    pending_after = []
    for pat in sorted(by_pattern):
        target = drum_dir / f"{pat}.m4a"
        if target.exists() or pat in copied:
            continue
        pending_after.append(pat)

    print("[4/4] writing PENDING_DRUM_MACHINE.txt ...")
    lines = []
    lines.append("# simpleStem — PENDING_DRUM_MACHINE.txt")
    lines.append(f"# Generated by drum_machine_inventory.py")
    lines.append(f"# Format: each pattern listed once, with the songs that reference it.")
    lines.append(f"# Drop a recording at: DRUM_MACHINE/<pattern>.m4a")
    lines.append("")
    lines.append(f"Total patterns waiting on a recording: {len(pending_after)}")
    lines.append("")
    for pat in pending_after:
        users = by_pattern[pat]
        lines.append(f"[{pat}]  ({len(users)} song{'s' if len(users)!=1 else ''})")
        for title, artist, base in users:
            lines.append(f"    - {title}{' — ' + artist if artist else ''}   <{base}>")
        lines.append("")

    content = "\n".join(lines).rstrip() + "\n"

    if args.dry_run:
        print(f"       [dry] would write {len(pending_after)} pattern entries to {pending_file}")
        print()
        print("---- preview ----")
        print(content)
    else:
        pending_file.write_text(content)
        print(f"       wrote {len(pending_after)} pattern entries to {pending_file}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
