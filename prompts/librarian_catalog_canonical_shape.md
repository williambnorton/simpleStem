# Librarian task: catalog.py emits the canonical library shape

**For:** the Claude session on the Librarian (mini).
**From:** the Performer's user — wants `CATALOG.json` to be the single
source of truth for the library, with both producer (catalog.py here) and
consumer (the portal's `tryLoadFromCatalog`) sharing one row format.

You are running on the Librarian. The audio data lives at
`~/ClaudeDrive/simpleStem/`. The code lives at `~/simpleStem-code/`.
Read [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`CLAUDE.md`](../CLAUDE.md),
and the JS scanner in
[`bt-construction-kit/server.js`](../bt-construction-kit/server.js)
first — that's the contract you need to match.

---

## Why this matters

Today `catalog.py` writes:

```json
{
  "generated_at": "...",
  "count": 224,
  "songs": { "<base>": { "title": "...", "artist": "...", "renditions": {...} } }
}
```

The Performer's portal expects:

```json
{
  "generated_at": "...",
  "source_mtimes": { "stems": "...ISO...", "m4a": "...ISO..." },
  "data": {
    "stats": { ... },
    "songs": [
      { "id": "stem-<base>", "type": "stems", ... },
      { "id": "m4a-<file>", "type": "m4a", ... },
      ...
    ]
  }
}
```

(songs is a flat **list**, not a dict, with one stems entry per song folder
plus one m4a entry per variant.)

When the catalog matches the portal's expected shape, the portal reads
CATALOG.json instead of walking STEMS/ + M4A/ — eliminates ~30-second
Drive stalls during library refresh. When it doesn't match, the portal
falls back to live filesystem scan (slower; the whole reason for this work).

A **conformance check** runs on the Performer at boot: it compares one
catalog row to a live-scanned row of the same folder. If the row shapers
diverge, it logs `[catalog-conformance] DRIFT detected...`. That's the
early-warning signal that catalog.py needs an update.

---

## What to produce

`catalog.py` should write `~/ClaudeDrive/simpleStem/CATALOG.json` with
this shape:

```python
{
    "generated_at": "<ISO timestamp UTC>",
    "source_mtimes": {
        "stems": "<ISO of STEMS/ dir mtime>",
        "m4a":   "<ISO of M4A/ dir mtime>",
    },
    "data": {
        "stats": {
            "totalSongs":  <int>,    # unique by (title, artist) — dedupe with the JS pickUniqueSongs rule
            "totalFiles":  <int>,    # raw entries: len(stems) + len(m4a)
            "totalStems":  <int>,    # count of stems-type rows
            "totalM4as":   <int>,    # count of m4a-type rows
            "artistCount": <int>,    # distinct non-"Unknown Artist" artists in the unique-songs set
            "bpmDistribution": { "slow": N, "medium": N, "fast": N, "unknown": N },
            "keyDistribution": { "C major": N, "D minor": N, ... },
        },
        "songs": [
            <stems row>,
            <stems row>,
            ...
            <m4a row>,
            <m4a row>,
            ...
        ],
    },
}
```

### Stems row (one per STEMS/<base>/)

```python
{
    "id":            f"stem-{folder_name}",
    "type":          "stems",
    "variantCode":   "STEMS",
    "variantLabel":  "Multitrack Stems",
    "folderName":    folder_name,                           # the slug, e.g. "Harvest_Moon_Neil_Young"
    "title":         meta.get("title") or fallback,
    "artist":        meta.get("artist") or "Unknown Artist",
    "practiceBpm":   meta.get("bpm") or None,               # JS calls it practiceBpm; we mirror that
    "originalBpm":   None,                                   # set if you have it; else None
    "key":           meta.get("key"),
    "keySignature":  meta.get("key_signature"),
    "stems": {
        "vocals":  "vocals.m4a"   if exists else "vocals.wav"  if exists else None,
        "drums":   ... same pattern,
        "bass":    ...,
        "guitar":  ...,
        "piano":   ...,
        "other":   ...,
        "rhythm":  "bass+drums.m4a"  if exists else "bass+drums.wav"  if exists else None,
        "source":  "source.m4a"      if exists else "source.wav"      if exists else None,
    },
    "loops": [                  # OPTIONAL — empty list is fine if you don't compute these
        # { "loopNum": int, "bars": int, "files": { "drums": "drums_loop1_27bars.wav", "bass": ... } }
    ],
    "duration":          meta.get("duration_sec"),
    "cached":            False,                              # the Performer overlays this; just set False
    "logicProjectName":  <first *.logicx in folder, or None>,
    "stats": {
        "stemCount": <count of non-None values in `stems`>,
        "loopCount": <len(loops)>,
    },
}
```

### M4A row (one per `M4A/<base>_<suffix>.m4a` that isn't a loop)

For each file in `M4A/` whose name doesn't match `*_loopN_Nbars.m4a`
and doesn't end in ` (N).m4a`:

```python
{
    "id":            f"m4a-{file_name}",
    "type":          "m4a",
    "fileName":      file_name,
    "title":         (sibling.title) or parse_from(stripped_name),
    "artist":        (sibling.artist) or "Unknown Artist",
    "practiceBpm":   (sibling.practiceBpm) or None,
    "originalBpm":   None,
    "key":           (sibling.key) or None,
    "keySignature":  (sibling.keySignature) or None,
    "duration":      (sibling.duration) or None,
    "cached":        False,
    "variantCode":   <one of "-V" "-V-G" "-V-G-B" "DO" "FULL">,
    "variantLabel":  <one of "No Vocals", "No Vocals/Guitar", "No Vocals/Guitar/Bass", "Drums Only", "Full Mix">,
}
```

Variant suffix detection (this is the JS rule from `scanM4a`, applied
in order — first match wins):

```python
VARIANT_PATTERNS = [
    (re.compile(r'_-V-G-B$', re.I),  "-V-G-B", "No Vocals/Guitar/Bass"),
    (re.compile(r'_-V-G$',   re.I),  "-V-G",   "No Vocals/Guitar"),
    (re.compile(r'_-V-B$',   re.I),  "-V-B",   "No Vocals/Bass"),
    (re.compile(r'_-V$',     re.I),  "-V",     "No Vocals"),
    (re.compile(r'_DO$',     re.I),  "DO",     "Drums Only"),
]
# Strip the matched suffix from the base name to find the sibling STEMS folder:
#     base = file_name.removesuffix('.m4a')
#     for pattern, code, label in VARIANT_PATTERNS:
#         if pattern.search(base):
#             stripped = pattern.sub('', base)
#             variantCode, variantLabel = code, label
#             break
#     else:
#         stripped = base
#         variantCode, variantLabel = "FULL", "Full Mix"
# The sibling STEMS folder is STEMS/<stripped>/
```

Use the sibling STEMS folder's metadata.json (title/artist/bpm/key/duration)
when present. The JS scanner does this so the m4a rows inherit the canonical
metadata rather than re-parsing from the filename.

### Sliding skip rules (must match scanM4a exactly)

```python
def should_skip_m4a(name):
    if re.search(r' \(\d+\)\.m4a$', name, re.I): return True       # Drive duplicate
    if re.search(r'[_ ]loop\d+[_ ]\d+bars\.m4a$', name, re.I): return True   # loop artifacts
    return False
```

```python
def should_skip_stems_dir(name):
    if re.search(r' \(\d+\)$', name): return True                  # Drive duplicate folders
    return False
```

### Stats computation

`pickUniqueSongs` rule from the JS: group by `(lowercased title, lowercased artist)`; prefer the stems
row when both stems and m4a exist for the same (title, artist) pair.

```python
def unique_songs(rows):
    norm = lambda s: re.sub(r'\s+', ' ', (s or '').lower()).strip()
    by_key = {}
    for r in rows:
        key = f"{norm(r['title'])}|{norm(r['artist'])}"
        prev = by_key.get(key)
        if not prev or (prev['type'] != 'stems' and r['type'] == 'stems'):
            by_key[key] = r
    return list(by_key.values())

uniques = unique_songs(all_rows)
stats = {
    "totalSongs":  len(uniques),
    "totalFiles":  len(all_rows),
    "totalStems":  sum(1 for r in all_rows if r['type'] == 'stems'),
    "totalM4as":   sum(1 for r in all_rows if r['type'] == 'm4a'),
    "artistCount": len({r['artist'] for r in uniques if r['artist'] and r['artist'] != 'Unknown Artist'}),
    "bpmDistribution": bpm_dist(uniques),
    "keyDistribution": key_dist(uniques),
}
```

`bpm_dist` buckets: `slow` < 90, `medium` 90-125, `fast` > 125, `unknown`
if `practiceBpm` is None.

`key_dist` is a count by `key` (skip None).

---

## How to verify

After updating `catalog.py`, run:

```
cd ~/simpleStem-code
./librarian.sh catalog
ls -la ~/ClaudeDrive/simpleStem/CATALOG.json
```

Then on the Performer (the user can `ssh` or call them and ask):

```
./performer.sh restart
./performer.sh logs server | grep catalog
```

Expected lines:
- `[catalog] mirror updated (...) — XXX KB` — local mirror picked up your new catalog
- `[lib] loaded from CATALOG.json (...) — N songs` — portal is now reading the catalog (not falling back to scan)
- `[catalog-conformance] <base> catalog row matches live scan ✓` — your row shape matches the JS scanner's

If you see `[catalog-conformance] DRIFT detected on <base>:` — that's a
shape mismatch. The log lists which fields differ. Fix the catalog.py
output for that field and re-run.

---

## Safety rules

- **DO NOT delete or rename CATALOG.json**'s existing fields without
  updating the Performer too. The portal's `tryLoadFromCatalog` falls
  back to scan if `parsed.data.songs` isn't an array, so a broken shape
  doesn't break the UI — but it does degrade performance back to the
  unfixed state.
- **DO NOT** touch `metadata.json` files; just READ them. The producer
  for `metadata.json` is `metadata.py`; catalog.py is purely a consumer.
- Always run `--report-only` first to preview your output without
  overwriting the existing CATALOG.json.
- After updating, run the test verification above and tick the boxes
  below before considering the task done.

---

## Status

`[ ] not started`
`[ ] updated catalog.py to produce canonical shape`
`[ ] tested locally (--report-only)`
`[ ] wrote new CATALOG.json (./librarian.sh catalog)`
`[ ] Performer confirms [lib] loaded from CATALOG.json`
`[ ] Performer confirms [catalog-conformance] match ✓`

Mark each box `[x]` as you complete it. Leave the file in place when done.
