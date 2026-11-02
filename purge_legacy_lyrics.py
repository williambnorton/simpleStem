#!/usr/bin/env python3
"""Remove legacy (non-pasted) lyrics from STEMS/*/metadata.json.

Keeps lyrics only where lyrics_source == 'manual' (the paste editor).
Dry run by default; pass --apply to write.
"""
import json, os, sys

root = os.environ.get("SIMPLE_STEM_ROOT", os.path.expanduser("~/ClaudeDrive/simpleStem"))
stems = os.path.join(root, "STEMS")
apply = "--apply" in sys.argv
fields = ("lyrics", "lyrics_chunks", "lyrics_source", "lyrics_fetched_at")

removed = kept = 0
for name in sorted(os.listdir(stems)):
    mp = os.path.join(stems, name, "metadata.json")
    if not os.path.isfile(mp):
        continue
    try:
        meta = json.load(open(mp))
    except Exception as e:
        print(f"skip {name}: {e}")
        continue
    if not meta.get("lyrics"):
        continue
    if meta.get("lyrics_source") == "manual":
        kept += 1
        continue
    removed += 1
    print(f"{'remove' if apply else 'would remove'}: {name}  (source={meta.get('lyrics_source')})")
    if apply:
        for f in fields:
            meta.pop(f, None)
        with open(mp, "w") as fh:
            json.dump(meta, fh, indent=2)
            fh.write("\n")

print(f"\n{'removed' if apply else 'would remove'} {removed}, kept {kept} pasted")
if not apply:
    print("dry run only — re-run with --apply to write")
