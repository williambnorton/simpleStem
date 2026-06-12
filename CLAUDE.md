# simpleStem — project guide for Claude

Read this first. It explains what the project is, how it's split across two
machines, where everything lives, and the rules for cooperating without
stepping on the other machine.

## What this is

A band backing-track system. It turns YouTube songs (and full-album/playlist
URLs) into 6-stem Demucs separations plus small "minus" m4a mixdowns, then
serves them through a web studio (`bt-construction-kit`) for rehearsal and
live use. End goal: load a setlist and, live, start playing instantly on low
(cell) bandwidth, upgrading quality as more audio arrives.

The end-to-end flow is drawn in `WORKFLOW.md` (Mermaid). In short:

```
YouTube URL → INCOMING_WEBLOC/*.webloc → webloc_watch.sh → metadata jobs in
STEM_QUEUE → queue_runner.sh → stem.sh (yt-dlp 48k → Demucs htdemucs_6s →
m4a mixdowns) → STEMS/ + M4A/ → bt-construction-kit (Express :3000) plays them
```

## Two-machine setup (important)

> **This split was REVERSED in May 2026. See `ARCHITECTURE.md` for the full
> rationale and the cache model.** Demucs now runs on the larger machine because
> the 8 GB machine ran out of memory. The roles below reflect the new layout.

This project runs across two Macs that both mount the same Google Drive folder
(`~/ClaudeDrive/simpleStem`). Their roles are **not** interchangeable:

| Machine | Drive mode | Role | Runs |
|---|---|---|---|
| **Mac mini** (8 GB, 24/7, external disk) — the **Librarian** | **mirrors** Drive to external disk | Ingest + cache + metadata + catalog | `librarian.sh` → `webloc_watch.sh` (download once → cache) + daily `catalog.py` |
| **MacBook Pro** (36 GB, travels) — the **Performer** | **streams** Drive, pins active jobs | Demucs render + serve live | `performer.sh` → `queue_runner.sh` + `stem.sh` (Demucs) + the portal |

Why this split (reversed from the original):

- **Demucs needs several GB of RAM** and crashed the 8 GB machine ("out of
  application memory"). It belongs on the 36 GB laptop.
- **The big audio file is fetched once.** The Librarian downloads `source.wav`
  into `STEMS/<base>/` (the cache); the Performer reuses it (`stem.sh` skips its
  own download). The audio crosses the network once, at home on wifi, and never
  touches the gig tether. (Previously YouTube was hit twice per song.)
- **The mini's work is light + I/O-bound** (download, slice, tag, queue, index),
  fine for 8 GB running 24/7 with the library on a big external disk.

### If you are the Claude on the Performer (laptop)

- Own rendering + the portal: `performer.sh start` runs `queue_runner.sh`
  (Demucs) and the `bt-construction-kit` server.
- **Do** edit `bt-construction-kit/` (server.js, public/*) and validate with
  `node --check`.
- **Don't** run the watcher/cataloger here — that's the Librarian's job.

### If you are the Claude on the Librarian (mini)

- Own ingest + the catalog: `librarian.sh start` runs `webloc_watch.sh` and the
  daily `catalog.py` pass; `librarian.sh catalog` runs the consistency pass now.
- **Never run Demucs here** (the memory crash). No `queue_runner.sh`/`stem.sh`.
- **Don't** change the `metadata.json` schema without also updating
  `metadata.py` and `catalog.py` — see Conventions.

## File map

Pipeline (acquisition machine):
- `studio.sh` — one control script: `start|stop|restart|status|logs`. Tracks
  PIDs/logs in `.run/`, tree-kills children (fswatch, node, demucs), clears the
  runner lock. **Start here.**
- `webloc_watch.sh` — watches `INCOMING_WEBLOC/` for `*.webloc`; a single video →
  one `STEM_QUEUE/<slug>.json`; a playlist (`list=`) or a chaptered "full album"
  video → a setlist staged in `/tmp/PENDING/<setlist>/` then moved whole into
  `STEM_QUEUE/<setlist>/`.
- `metadata.py` — per song: BPM + key (librosa), version (live/studio/…),
  MusicBrainz year, lyric/chord search URLs, `clip_start/end` (album chapters),
  and a `processing` block (48 kHz, Demucs htdemucs_6s, the m4a mixdowns).
  Flags: `--clip-start`, `--duration`, `--info-json`, `--url`, `--force`.
- `queue_runner.sh` — consumes `STEM_QUEUE`, runs `stem.sh` per job (album
  chapters: download whole video, slice the clip window, then stem). Publishes
  the current job + phase to `STEM_QUEUE/.current`; moves finished jobs to
  `_done/`, failures to `_failed/`.
- `stem.sh` — the heavy worker: yt-dlp → 48 kHz `source.wav` → Demucs
  htdemucs_6s (6 stems) → m4a mixdowns. Writes `STEMS/<slug>/`.
- `post_process.py` — gain-match stems to source. `loop_detect.py` — beat-synced
  loops. `batch.bash` / `mpbbatch.bash` — older Google-Sheet batch path.
- Docker: `Dockerfile`, `docker-compose.yml`, `entrypoint.sh` — containerized
  stem/batch runs (bundles ffmpeg/yt-dlp/demucs).

UI (studio machine):
- `bt-construction-kit/` — Express 5 server (`server.js`, port 3000) + static
  UI in `public/`. Endpoints: `GET /api/library`, `GET /api/audio/stems/:song/:file`,
  `GET /api/audio/m4a/:file`, `POST /api/enqueue` (drops a `.webloc`),
  `GET /api/queue` (live status), `POST /api/precache/...`. Reads `STEMS/`,
  `M4A/`, and each song's `metadata.json`; caches audio to `~/.bt-cache`.
- `start_server.bash` — `cd bt-construction-kit && node server.js`.

Data (shared via Drive, git-ignored — see below):
- `STEMS/<slug>/` — `source.wav`, 6 stems, `metadata.json`, loops.
- `M4A/` — mixdowns `<Title>_<Artist>_<suffix>.m4a`.
- `STEM_QUEUE/`, `INCOMING_WEBLOC/` — runtime queues. `.run/` — PIDs/logs.

Docs: `WORKFLOW.md` (diagram), `README.md`, `README-DRAFT.md`.

## Running it

On the **mini (Librarian)**:
```
cd ~/ClaudeDrive/simpleStem
./librarian.sh start          # watcher (ingest→cache) + daily catalog poll
./librarian.sh catalog        # run the consistency pass once, now
./librarian.sh status
```

On the **laptop (Performer)**:
```
cd ~/ClaudeDrive/simpleStem
(cd bt-construction-kit && npm install)   # once
./performer.sh start          # queue_runner (Demucs) + portal
./performer.sh status         # queue depth + current render & phase
./performer.sh logs runner
./performer.sh stop
```

> `studio.sh` is the legacy single-machine switch (ingest+render+serve on one
> Mac). It still works but predates the cache model and the machine flip; prefer
> `librarian.sh` / `performer.sh`. A full rebuild is staged with `./rebuild.sh`
> (dry-run by default; `--go` to execute) — see `ARCHITECTURE.md`.

Add a song from the portal's "Add from YouTube" box (or drop a `.webloc` into
`INCOMING_WEBLOC/`). Render phases show in the portal and in `status`:
`downloading source → analyzing (BPM/key) → separating stems · demucs → mixing
m4a`. Demucs is ~10–25 min/song on CPU; that's expected — a new request just
queues behind the current song.

## CATALOG.json is the library API contract

The portal's library is served from `~/ClaudeDrive/simpleStem/CATALOG.json`
(via a local mirror at `~/.simpleStem-catalog/CATALOG.json` — Drive is
NEVER in the request hot path). Two row shapers produce the same
canonical row format:

- **Producer**: `catalog.py` on the Librarian
- **Consumer (fallback)**: `scanStems` / `scanM4a` in `bt-construction-kit/server.js`

Both must agree byte-for-byte on the row shape. A boot-time
`runCatalogConformanceCheck` walks one row through both shapers and
logs `[catalog-conformance] DRIFT` when they disagree.

**If you touch the row format on either side, update the other side
in the same PR.** The shape is documented in detail in
`ARCHITECTURE.md > CATALOG.json — the shared index` (and in the
matching brief `prompts/librarian_catalog_canonical_shape.md` for the
Librarian Claude).

## Gig → Setlist → Song — the live-use hierarchy

The portal organizes a performance around three nested levels. Treat
this as load-bearing; the sidebar UI mirrors it, the URLs follow it,
the file layout follows it.

```
Gig            (1)
 └─ Setlist    (1–4 per gig, ordered, sequential in time)
     └─ Song   (1+ per setlist, ordered, sequential in time)
         └─ Stems + synchronized timeline (BPM, key, MIDI automation)
```

### Where each level lives on disk

| Level | Lives in | Owner | Editable from portal? |
|---|---|---|---|
| **Gig** (real) | `GIGS/<slug>.json` — top-level `{title, setlists:[...]}`. Setlists are EMBEDDED inside the gig file. | The user via the gig sidebar. | Yes — gig CRUD via `/api/gigs`. |
| **Setlist** (standalone) | `SETLISTS/<slug>.json` — top-level `{title, origin, songs:[...]}`. `origin` is either `'manual'` (user-created in the planner) or `'playlist'` (sync'd from a YouTube playlist by `setlist_sync.py`). | `'manual'` → the user. `'playlist'` → `setlist_sync.py`. | `'manual'`: yes via `POST /api/setlists`. `'playlist'`: NO — re-sync overwrites changes. |
| **Song** | `STEMS/<song_base>/metadata.json` + the stems/m4a files. | Pipeline (`webloc_watch` → `metadata.py` → `stem.sh`). | Per-song metadata + MIDI automation timeline editable via `/api/song/:base/automation`. |

### Two visibility surfaces for standalone setlists

The gig sidebar shows the active gig's setlists. To make standalone
setlists reachable without forcing the user to first add them to a real
gig, the portal exposes them via two **synthetic pseudo-gigs** that
live ONLY on the client (no `GIGS/` file):

- **`__youtube_sync__`** — "YouTube Sync" — aggregates every setlist
  where `origin === 'playlist'`. Read-only: editing buttons disabled,
  `scheduleGigSave` is a no-op, because `setlist_sync.py` would
  overwrite changes on the next playlist refresh.
- **`__manual_setlists__`** — "Manual Setlists" — aggregates every
  setlist where `origin === 'manual'`. Editable: per-setlist title and
  song-list edits are persisted via `POST /api/setlists` (one POST
  per modified setlist via `persistManualSetlists()` in `app.js`).

Both pseudo-gigs appear at the top of the gig picker before any real
gig. Real gigs (Joyce, Sunday_Practice, …) follow.

### Song timeline + MIDI automation

A song carries a synchronized timeline in its `metadata.json` under an
`automation` array. Each event has `{t, device, type, channel, ...}`
and is fired as the playhead crosses its timestamp during playback.
The browser POSTs each event to `/api/midi/send`, which proxies to
`midi_sidecar.py` (Python daemon on `:5555`) which hits the actual
MIDI port via `mido`.

Devices supported in v1: **Helix** (channel 4 by default, USB-C),
**Logic Pro** (via IAC Driver bus), **XR18** (USB). The sidecar
matches port names by case-insensitive substring, so the substring
"helix" hits "Helix Native" / "HX Stomp" / whatever the OS calls it.

Events are stored as Program Change or Control Change for v1. Ramps
(continuous fader rides) are not implemented; each event is one-shot.
Editor is the yellow lane below the visualizer in the portal.

### MPB Songlist sync (`mpb_sync.py`)

The band already maintains the canonical song list in a Google Sheet
("New Mitchell Park Song List"). `mpb_sync.py` runs on the **Librarian** and
pulls that sheet daily, mapping each row to the matching `STEMS/<slug>/`
folder by normalized title + artist. It writes six MPB fields into each
matched `metadata.json` and never touches anything else:

- `singer_raw` — the literal Vocals column value (e.g. `"JD (Matt)"`).
- `singer_lead` — primary vocalist (first name token, e.g. `"JD"`).
- `singer_backup` — parenthesized fallback singer (e.g. `"Matt"`).
- `singer_group_vocal` — `true` when Vocals is `"All"`.
- `band_required` — list parsed from the Reqd column
  (e.g. `["Bill","Matt","Dan"]`). Lets the portal filter the library to
  songs the present roster can actually play.
- `drum_pattern` — opaque Drums column verbatim (`"120@130"`, `"95UduHop"`,
  `"ACTUAL"`, …). The portal displays it as a pill; it doesn't try to parse.
- `readiness` — State column verbatim (`"InTheCan"` / `"Rehearse"` / `"tbd"`).

For each gig tab in the sheet (May Day 26, EDR 4/24, MV 3/31, NK3 March 28),
the script also splits songs into setlists at Seq=N00 boundaries, names each
setlist from the divider row's title (`"5:50PM Mid Rally Set"`, `"Break"`,
`"Encore"`, …), matches each song to a `STEMS/<slug>/` folder, and writes
`GIGS/<gig_slug>.json`.

Unmatched rows go to `LOGS/mpb_sync_report.json` for triage. The script
never auto-creates STEMS dirs and never enqueues new renders.

**Configuration:** `mpb_sync_config.json` next to the script lists the
sheet ID, master sheet name, and gig sheet names. **The sheet must be shared
as "Anyone with the link can view"** so the gviz CSV endpoint returns data
without OAuth.

**Cadence:** the Librarian runs it every 24 h as a separate service
(`librarian.sh start` brings `mpbsync` up alongside `watcher`, `cataloger`,
and `catalogwatch`). Manual triggers: `./librarian.sh sheet` (full sync),
`./librarian.sh sheet --dry-run` (preview), `./librarian.sh sheet
--master-only` (skip the gig tabs).

### Section auto-detection (`section_detect.py`)

When `stem.sh` finishes a render, it calls `section_detect.py` on the song
folder. That script runs a multi-stem novelty function:

1. Load each stem's audio, compute RMS energy envelope at 10 Hz.
2. Take the per-stem absolute first derivative (energy change rate).
3. Sum the derivatives across stems → combined "section change strength."
4. Find peaks above 35% of the global max with ≥6 s spacing.
5. Write the peak timestamps to `metadata.json` as `sectionCandidates`.

The portal's `/api/song/:base/automation` endpoint exposes these
candidates alongside the editable `sections` array. The client uses them
two ways:

- **Snap on placement.** When the user drops a section (key 1–9) or
  drags a section divider, `snapSectionToCandidate(t)` looks for a
  candidate within ±2 s and snaps to it. Falls back to BPM-grid snap
  if none is in range.
- **Visual hints.** Faint vertical ticks on the lane background mark
  every candidate timestamp, so the user can see where the algorithm
  thinks boundaries are before placing their own.

Backfill the existing library: `./backfill_section_detect.sh --go`.
~3 sec per song on CPU, ~9 min for 176 songs.

### Time-of-day scheduling (planned)

Songs carry `duration_sec` in metadata. Setlist projected start/end
times are computed by summing durations from a gig-level "start time"
field. This is NOT YET WIRED — see the roadmap.

## Conventions

- **Shell snippets pasted into zsh — NEVER use `#` comments inside the code
  block, in any form, in any position.** No same-line trailing comments
  (`git push origin main # pushes the fix`), no leading comment lines
  (`# pull first`), no separator banners. zsh defaults to
  `no_interactive_comments`, and even when the comment is on its own
  line some shells/clients trim leading whitespace strangely or the
  user mass-pastes the block and the comment lines split mid-token.
  The only safe shape for paste-targeted code blocks is plain commands.
  If the commands need explanation, put it as PROSE OUTSIDE the code
  block (above or below). This is non-negotiable — bare `bash` examples
  in the docs are fine to comment, but ANYTHING the user is meant to
  copy-paste into their terminal is comment-free.

- **Slug**: lowercase, spaces → `_`, drop anything but `[a-z0-9_-]`. Song files
  are `<slug>.json`; setlist entries are `NN_<slug>.json` (zero-padded order).
- **M4A naming**: `<Title>_<Artist>_<suffix>.m4a`, suffix ∈ `-V`, `-V-G`,
  `-V-G-B`, `DO`; no suffix = full mix ("FULL"). The library scanner ignores
  ` (N)` duplicate copies.
- **metadata.json** (the contract between producer and consumer): `title`,
  `artist`, `source_url`, `version`, `duration_sec`, `clip_start_sec`,
  `clip_end_sec`, `bpm`, `key`, `key_signature`, `lyrics_search_url`,
  `chords_search_url`, `processing{download,separation,mixdowns}`, optional
  `drum_pattern` (opaque string the portal displays as a pill next to
  BPM/key — e.g. `"120@96"` for "BPM 120, drum machine pattern 96"), and
  for setlist members `playlist_title` + `sequence_number`. Songs that have
  been touched by `mpb_sync.py` also carry the MPB Songlist fields
  `singer_raw`, `singer_lead`, `singer_backup`, `singer_group_vocal`,
  `band_required` (list, e.g. `["Bill","Matt","Dan"]`), and `readiness`
  (`"InTheCan"`/`"Rehearse"`/`"tbd"`). **Producers:** `metadata.py` (audio
  analysis), `mpb_sync.py` (Songlist fields). **Consumer:**
  `bt-construction-kit/server.js`. Change all of them together.
- **Version stamp**: the portal's brand chip displays a build timestamp
  derived from the newest mtime across the code files, formatted
  `V1.MMDDHHMM` (e.g. `V1.06071402`). No manual bumping — when Drive syncs
  newer files to a machine, `BOOT_VERSION` advances on the next restart.

## Git & sync

The repo tracks **code only**; the big/transient data dirs are git-ignored (see
`.gitignore`). Recommended workflow:

1. Add a remote (e.g. GitHub) so the two machines exchange code:
   `git remote add origin <url>` and `git push -u origin main`.
2. On each machine: `git pull` before editing, commit small, `git push`.
3. The Studio Mac is the primary editor of `bt-construction-kit/`.

Caveat: the repo lives inside a Google-Drive-synced folder, so `.git` itself
syncs. To avoid corruption, **don't run git operations on both machines at the
same time**, prefer pulling from the remote over relying on Drive to sync code,
and ideally exclude `.git` from Drive sync if your client allows it.

Known friction: Drive can leave stale lock files in `.git` that block the next
git command. If you see `Unable to create '.git/index.lock': File exists` (or
similar), clear them:

```
rm -f .git/index.lock .git/HEAD.lock .git/objects/maintenance.lock
```

Most robust long-term: host the canonical repo on a remote (GitHub) and let each
machine pull from it, rather than trusting Drive to sync `.git`.

## Constraints & gotchas

- **Logic Pro 12 Stem Splitter produces 6 stems** (vocals, drums, bass, guitar,
  piano, "other") — *not* the 4 (vocals/drums/bass/other) that earlier Logic
  versions and most third-party write-ups describe. Don't assert otherwise in
  designs that hand off to Logic; the KBM `simpleStem` macro is built around
  the 6-stem output and matches the demucs `htdemucs_6s` shape one-to-one.

- **Memory (8 GB acquisition Mac):** don't pile heavy UI/agent work on top of
  Demucs — that's what the two-machine split is for.
- **Hardcoded path:** `bt-construction-kit/server.js` sets
  `SIMPLE_STEM_ROOT = '/Users/wbn/ClaudeDrive/simpleStem'`. Verify this resolves
  on each machine; if usernames/mounts differ, this breaks. Worth refactoring to
  `os.homedir()` + `ClaudeDrive/simpleStem`.
- **One `queue_runner` at a time** (it holds `STEM_QUEUE/.runner.lock`); run it
  only on the acquisition machine.
- **Drive streaming latency:** first play of an uncached file on the Studio Mac
  is slow; the server caches to `~/.bt-cache`.

## Status & roadmap

Built and working: the webloc watcher; metadata generation (incl. clip windows
and the processing spec); the queue runner; portal enqueue + live queue status;
`studio.sh`; library cleanup + scanner hardening against ` (N)` duplicates.

Next (deferred "feature 2") — progressive live playback for low bandwidth:
- Have `stem.sh` also export a small **full-mix m4a**, and emit the **`-V`**
  mixdown (the `processing` spec already lists `-V`; `stem.sh` currently makes
  only `-V-G`, `-V-G-B`, `DO`).
- Reorder `stem.sh` to produce the small m4a files **before** the slow stems.
- Client ladder: play full mix instantly → swap to `-V` → `-V-G` as each small
  file arrives → pull 6 stems in the background. (`app.js` already hot-swaps
  variants and precaches; this extends the ladder and ordering.)
