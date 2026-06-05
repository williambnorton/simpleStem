# Librarian task: fix Led Zeppelin chapter-album misnaming

**For:** the Claude session running on the Librarian (Mac mini).
**From:** the Performer's user, observing the problem in the portal.
**Authority:** the user — the Performer's Claude has been told to author
this brief but has no access to fix the data itself (Drive permissions).

You are running on the Librarian. The audio data lives at
`~/ClaudeDrive/simpleStem/`. The code lives at `~/simpleStem-code/`.
Read [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`CLAUDE.md`](../CLAUDE.md),
and [`lib-common.sh`](../lib-common.sh) first — that's the context you
need.

---

## Symptoms the user is seeing

In the portal's Library tab, several rows look like:

| Title | Artist | Tempo | Key |
|---|---|---|---|
| `1 01 Whole Lotta Love Lone Star` | `V` | — | — |
| `1 02 …` | `Lone Star` | — | — |
| `1 03 …` | `V` | — | — |
| (etc.) |

All numeric-prefixed. All misattributed to **Lone Star** (a different
band entirely) or **V** (just the tail token of the slug). All of them
are actually from a **chaptered YouTube video of a Led Zeppelin album**
that was ingested as a single video, with each chapter becoming its own
song.

The user wants these renamed so:
- The numeric prefix is dropped.
- The artist is corrected to **Led Zeppelin**.
- The title is just the song name.

---

## Root cause (so you understand what you're fixing)

`webloc_watch.sh` ingested the chaptered album as a single video. Each
chapter became a song. `metadata.py`'s slugifier kept the chapter prefix
(`1 01 `, `1 02 `, …) and the title/artist splitter picked the wrong
token as the artist because the cleaned title still had multiple words
and "Lone Star" was probably in `KNOWN_ARTISTS`.

You **do not** need to fix `metadata.py` as part of this task (that's a
separate hardening pass; flag it at the end). For now, fix the data.

---

## What to do

### Step 1: Discover the affected songs

In `~/ClaudeDrive/simpleStem/STEMS/`, list every folder whose name starts
with a digit-prefix pattern. Use the actual mount path on the Librarian.

```
cd ~/ClaudeDrive/simpleStem/STEMS
ls | grep -E '^[0-9]+_[0-9]+_'
```

Each match is a candidate. Read each one's `metadata.json` to confirm
it's from the Led Zeppelin album (check `youtube_title`,
`youtube_uploader`, or `source_url` — they should all point to the same
album video). If a song doesn't look like Led Zeppelin, **skip it** and
report it at the end.

### Step 2: Propose the renames to the user

**Do not rename anything yet.** Print a table showing your plan:

```
old folder                                  →  new folder                        new artist
1_01_Whole_Lotta_Love_Lone_Star             →  Whole_Lotta_Love_Led_Zeppelin     Led Zeppelin
1_02_What_Is_And_What_Should_Never_Be_…     →  What_Is_And_What_Should_Never_Be_Led_Zeppelin   Led Zeppelin
…
```

Ask the user to confirm before proceeding. Cover edge cases:
- Same cleaned-title already exists as a STEMS folder (collision). Flag
  it; don't overwrite.
- `metadata.json` already has artist = "Led Zeppelin" (someone already
  fixed it). Skip it.
- Cleaned title would be empty after prefix-stripping. Skip and report.

### Step 3: Execute the renames

For each approved row:

1. **Rename the STEMS folder**: `mv STEMS/<old> STEMS/<new>`.
2. **Edit the renamed folder's `metadata.json`**:
   - `title` → the cleaned title (no digit prefix, no false artist tail)
   - `artist` → `Led Zeppelin`
   - `processing.download.song_base` (if present) → the new base
3. **Rename matching M4A files** in `~/ClaudeDrive/simpleStem/M4A/`:
   ```
   for f in M4A/<old>_*; do
     newf="$(echo "$f" | sed "s|<old>|<new>|")"
     mv "$f" "$newf"
   done
   ```
   This covers `-V`, `-V-G`, `-V-G-B`, `DO`, `_loop*` files all at once.

### Step 4: Rebuild the catalog

```
cd ~/simpleStem-code
./librarian.sh catalog
```

This re-scans STEMS/ and M4A/ and rewrites CATALOG.json from the new
state.

### Step 5: Tell the user what you did

Report:
- How many songs you renamed
- Any songs you skipped and why
- That they should reload the portal on the Performer (the library
  cache invalidates on the next mtime change, which the renames just
  triggered)

---

## Safety rules

- **DO NOT delete any files.** Only rename and edit metadata.
- **DO NOT touch songs not in the affected set.** A wide grep + a quick
  artist sanity check on each match is the right granularity.
- **Always confirm before executing.** Show the rename plan; wait for OK.
- **One-shot:** when done, leave this file in place but mark it
  completed at the bottom (so the next Librarian session sees it's
  done and skips it).

---

## Useful pointers

- Slug rule: `lib-common.sh` has `slugify()` and `song_base()`. Use them
  for the new names so they match the canonical convention.
- `metadata.json` schema: see ARCHITECTURE.md > "Data contracts".
- M4A filename convention: `<base>_<suffix>.m4a` where suffix is one of
  `-V`, `-V-G`, `-V-G-B`, `DO`, or empty (full mix). Loop files:
  `<base>_<variant>_loopN_Mbars.m4a`. All of them share the `<base>`
  prefix, so the `sed`-rename above catches them.
- Portal library-cache mtime gate: the cache invalidates when the
  STEMS/ or M4A/ directory mtime changes. Your renames bump those.

---

## Optional follow-up (only if you have time)

Worth investigating, but separate task:

1. `metadata.py`'s chapter-album handling — see how chapter prefixes
   end up in slugs, and add an option to drop them automatically.
2. `parseSongMetadata` in `bt-construction-kit/server.js` — the
   title/artist splitter shouldn't be willing to pick a known artist
   name out of the middle of a title that's clearly chapter-prefixed.
3. The portal's "library hygiene" panel (see ARCHITECTURE.md roadmap)
   would have surfaced these as flagged anomalies — that's the
   long-term answer.

---

## Status

`[ ] not started`
`[ ] proposed renames to user`
`[ ] user confirmed`
`[ ] renames executed`
`[ ] catalog rebuilt`
`[ ] user notified`

Mark each box `[x]` as you complete it.
