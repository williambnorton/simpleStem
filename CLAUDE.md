# simpleStem — project guide for Claude

Read this first. It explains what the project is, how it's split across two
machines, where everything lives, and the rules for cooperating without
stepping on the other machine.

## What this is

A band backing-track system. It turns YouTube songs (and full-album/playlist
URLs) into 6-stem Demucs separations served through a web studio
(`bt-construction-kit`) for rehearsal and live use. The portal mixes the
six stems client-side — no pre-baked mixdowns, no per-song loop files. End
goal: load a setlist and, live, drive the XR18 with per-stem level + routing
control.

The end-to-end flow is drawn in `WORKFLOW.md` (Mermaid). In short:

```
YouTube URL → INCOMING_WEBLOC/*.webloc → webloc_watch.sh → metadata jobs in
STEM_QUEUE → queue_runner.sh → stem.sh (yt-dlp 48k → Demucs htdemucs_6s)
→ STEMS/<slug>/{vocals,drums,bass,guitar,piano,other}.m4a + metadata.json
→ bt-construction-kit (Express :3000) mixes them client-side → XR18.
```

> **2026-06-27 — Mixdowns and loops retired.** Earlier builds also emitted
> "minus" variants (`-V`, `-V-G`, `-V-G-B`, `DO`) into `M4A/` and per-song
> loop files. Those code paths are gone. The portal's Web Audio graph mixes
> the six stems live; a future "loop construction kit" feature will be
> designed from scratch when needed. Migration: `./retire_legacy_files.sh`
> moves existing `M4A/` and loops aside; purge later with `rm -rf`.

## Architecture roles (important)

The system is split by **what it does live vs what it curates offline**, not
just by hardware. Three roles share the same Drive folder
(`~/ClaudeDrive/simpleStem`):

| Role | Hardware (typical) | Drive mode | Responsibility |
|---|---|---|---|
| **Performer** — the **live App** | MacBook Pro (36 GB, travels) | streams Drive, pins active jobs | The portal at gig time. Plays back the six stems (mixed client-side) plus drum patterns and clips. Drives the XR18. Fires automation events. **Must run offline** — no internet at the venue. Also runs Demucs renders when home on wifi. |
| **Song Librarian** | Mac mini (8 GB, 24/7) | mirrors Drive to external disk | Curates the song library. `webloc_watch.sh` ingests YouTube URLs, `metadata.py` analyzes BPM/key, `catalog.py` keeps `CATALOG.json` consistent, `mpb_sync.py` pulls Songlist fields. Writes to `STEMS/` and `CATALOG.json`. |
| **Clip Librarian** | Any Mac with Logic Pro + BlackHole | mirrors Drive (or copy out) | Curates the clip library. Uses video downloaders, BlackHole + Logic Pro for hard-to-grab sources, ffmpeg trim. Writes to `CUSTOM_LOOPS/`. **Lives outside the App** — see `clip_librarian/README.md`. |

**Why this split:**

- **The App must be reliable at the gig.** No internet at most venues, no time
  to wait on yt-dlp 403s mid-song. So the App reads from local caches only;
  every external thing — YouTube URLs, audio capture, ffmpeg trim — moves out
  to the Librarian roles.
- **Curation is iterative and slow.** Trimming a sample, EQing it, re-rendering
  through Logic Pro happens at desk over coffee, not at the wedge. Same logic
  the song pipeline already uses (Demucs takes 25 min per song).
- **Mac apps are powerful.** Logic Pro, BlackHole, dedicated video downloaders
  do the audio capture/cleanup work better than anything we'd ever build into
  the portal. Lean on them; the App just consumes the resulting .m4a files.

### If you are the Claude on the Performer (laptop)

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

### If you are the Claude on the Song Librarian (mini)

- Own ingest + the catalog: `librarian.sh start` runs `webloc_watch.sh` and the
  daily `catalog.py` pass; `librarian.sh catalog` runs the consistency pass now.
- **Never run Demucs here** (the memory crash). No `queue_runner.sh`/`stem.sh`.
- **Don't** change the `metadata.json` schema without also updating
  `metadata.py` and `catalog.py` — see Conventions.

### If you are doing Clip Librarian work

- The App **never fetches** clips. Your job is to land `.m4a` files in
  `CUSTOM_LOOPS/`; the App auto-precaches them and surfaces them in the
  Sampler panel + the + CLIP action picker.
- For straightforward sources (YouTube et al.), use `clip_librarian/fetch_clip.sh`
  and `trim_clip.sh` — small CLI wrappers around yt-dlp + ffmpeg with the same
  naming and trim semantics the old in-app workflow used.
- For hard sources (Twitter, Instagram, sites that rate-limit yt-dlp), the
  fallback is **BlackHole + Logic Pro**: route system audio to BlackHole, record
  in Logic, bounce a region as m4a, drop into `CUSTOM_LOOPS/`. The README in
  `clip_librarian/` walks through the setup.
- The App does NOT need restarting when you add clips. Its CUSTOM_LOOPS list is
  scanned on demand via `/api/custom-loops/list`.

## Which machine runs what

Every command set Claude writes must explicitly say which machine it runs on.
The user has hit confusion in the past from "run this" with no machine hint.
Pick from this table:

| Operation | Machine | Why |
|---|---|---|
| Ingest a `.webloc` (drop into `INCOMING_WEBLOC/`) | **Librarian** | `webloc_watch.sh` runs here, downloads source.wav into the STEMS cache, writes the metadata job into `STEM_QUEUE/`. |
| `webloc_watch.sh` | **Librarian** | Daemonized by `librarian.sh start`. |
| `metadata.py` (analyzing source.wav for BPM/key) | **Librarian** | Called by `webloc_watch.sh` after the slice is ready. |
| `mpb_sync.py` / `./librarian.sh sheet` | **Librarian** | Pulls the Google Sheet songlist and writes singer/band/drum-pattern fields. |
| `catalog.py` / `./librarian.sh catalog` | **Librarian** | **Owner of `CATALOG.json`.** Runs hourly via `librarian.sh start`; you can re-trigger by hand. Performer reads a mirror of the file. |
| `queue_runner.sh` (Demucs queue consumer) | **Performer** | `performer.sh start` starts this. Pulls jobs from `STEM_QUEUE/`, runs Demucs, writes 6 stems + metadata. |
| `stem.sh` (single-job demucs render) | **Performer** | Called by `queue_runner.sh`. |
| `bt-construction-kit/` Express server | **Performer** | `performer.sh start` brings up the portal at `:3000`. |
| `backfill_section_detect.sh` | **Performer** | Needs the demucs venv's `librosa`. |
| `retire_legacy_files.sh` | **Either** | One-shot migration that moves the retired `M4A/` and per-song loop artefacts aside. Reversible. |
| `section_detect.py` (single-song) | **Performer** | Same reason as the backfill — librosa lives in the demucs venv. |
| `post_process.py` | **Performer** | Optional gain-matching pass; not run automatically. |
| MIDI sidecar (`midi_sidecar.py`) | **Performer** | Drives the user's Helix / XR18 / Logic via macOS MIDI ports — must be on the gig laptop. |
| Editing `bt-construction-kit/` source | **Performer** | The Performer is the primary editor and pushes; the Librarian pulls. |
| Editing `catalog.py` / `mpb_sync.py` / shared `.sh` | **Either, but commit + push from the Performer** | Drive sync of `.git` is unreliable; canonical writes go through GitHub. |
| `git pull` / `git push` | **Both, never simultaneously** | Drive sync corrupts `.git` if both machines `git` at the same time. |

**When a command set says "on the Performer:" run it on the laptop; "on the
Librarian:" run it on the Mac mini.** If a step has to happen on both, the
command set lists them in order (e.g. push from Performer → pull on Librarian).

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
  lyric/chord search URLs, `clip_start/end` (album chapters), and a
  `processing` block (48 kHz, Demucs htdemucs_6s). MusicBrainz year
  lookup retired 2026-06-28 — operator pastes lyrics + facts via the
  Performer's lyrics dialog (Google / UG / AZLyrics) or manual Google.
  Flags: `--clip-start`, `--duration`, `--info-json`, `--url`, `--force`.
- `queue_runner.sh` — consumes `STEM_QUEUE`, runs `stem.sh` per job (album
  chapters: download whole video, slice the clip window, then stem). Publishes
  the current job + phase to `STEM_QUEUE/.current`; moves finished jobs to
  `_done/`, failures to `_failed/`.
- `stem.sh` — the heavy worker: yt-dlp → 48 kHz `source.wav` → Demucs
  htdemucs_6s (6 stems) → m4a transcode. Writes `STEMS/<slug>/`.
- `post_process.py` — optional gain-matching pass, not run automatically.
  Earlier `loop_detect.py` / mixdown emitters were retired 2026-06-27 — see
  the Status & roadmap note about the future loop construction kit.
  The legacy Google-Sheet batch path (`mpbbatch.bash`) and the Docker bundle
  are likewise retired; `mpb_sync.py` driven by `librarian.sh sheet` is the
  only sheet-sync entry point now.

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

In addition to those two, the picker exposes seven more synthetic
pseudo-gigs, all built from `mergedLibrary` on the client (no
`GIGS/` or `SETLISTS/` files back them):

- **`__recents__`** — last 50 songs the operator loaded (read from
  `RECENTS.json` via `GET /api/recents`).
- **`__favorites__`** — every song with `meta.favorite === true`
  (read from each `metadata.json` via `GET /api/favorites`).
- **`__bill_songs__` / `__matt_songs__` / `__dan_songs__` /
  `__jd_songs__`** — singer-filtered. Each one matches stems whose
  `metadata.singer_lead` equals the singer's first name
  (case-insensitive). Songs are sorted alphabetically.
- **`__round_robin__`** — interleaves the four singer buckets.
  Each bucket is independently Fisher-Yates shuffled, then the
  setlist is built by round-robin (Bill → Matt → Dan → JD → Bill …)
  until every bucket drains. Useful when one singer needs to step
  away mid-set without leaving dead air.

All seven are read-only. To stop seeing a song in a singer
pseudo-gig, change `singer_lead` either via the sheet (canonical)
or via the new in-row pulldown (`PUT /api/song/:base/singer`).

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

- **All songs' m4a stems must be in `~/.bt-cache` at all times — there is NO
  warming phase.** simpleStem's offline-gig contract is absolute: if a song
  appears in `/api/library`, its six m4a stems live in `~/.bt-cache/STEMS/<base>/`
  and are ready for end-to-end playback with no wifi. Bill plays venues with
  no internet — a "Song failed to load" dialog at downbeat is a show-stopper.

  **What this means in practice:**
  - Any code path that touches Drive in the audio-serving hot path is a bug.
    `sendCachedAudio` must serve from `~/.bt-cache` without `existsSync`/`statSync`
    on the Drive `sourcePath` (synchronous Drive reads wedge Node's event loop
    when offline; macOS CloudStorage can block 30+ seconds).
  - The boot-time `precacheAllStemsM4a` is not optional. The Flash Cache
    button (mixer header, hard-drive-download icon) lets the operator force a
    full re-precache before leaving for a gig. Shift-click = force overwrite.
  - `POST /api/cache/flash` triggers it programmatically; `GET /api/cache/status`
    returns live progress so the UI can show `done/total · copied/skipped/failed`.
  - A failed `precacheAllStemsM4a` is loud — error banner, not silent fall-through.
  - The expected library size on disk is library_count × 6 stems × ~5 MB ≈ a few GB
    for a few hundred songs. Well under the 50 GB `BT_CACHE_CAP_GB` default.
  - Test the contract: at home, play a song. Disable wifi. Reopen the app.
    EVERY song in the library must play end-to-end. Any failure is a policy violation.

- **File format policy: m4a only.** The only audio file format simpleStem
  uses going forward is **`.m4a`** (AAC in MPEG-4 container). The single
  exception is **`source.wav`** in each `STEMS/<slug>/` folder — the raw
  48 kHz ingest we keep so we can re-stem without re-downloading from
  YouTube. Everything else — the 6 separated stems and the drum-machine
  patterns — lives as m4a on disk and is served as m4a by the portal.
  Per-stem `.wav` files written by older versions of `stem.sh` should be
  cleaned up; see `cleanup_stems_wav.py` at the simpleStem root.
  **Producers** (`stem.sh` plus any future ingest paths) must emit m4a
  — never new `.wav` outside of `source.wav`. **Consumers**
  (`bt-construction-kit/server.js`, `catalog.py`, the portal) read m4a only.

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
- **Stem naming (inside `STEMS/<slug>/`)**: `vocals.m4a`, `drums.m4a`,
  `bass.m4a`, `guitar.m4a`, `piano.m4a`, `other.m4a`. Plus `source.wav`
  (the 48 kHz reference, kept so we can re-stem without re-downloading)
  and `metadata.json`. The legacy `<Title>_<Artist>_<suffix>.m4a`
  mixdowns in `M4A/` (`-V`, `-V-G`, `-V-G-B`, `DO`, `FULL`) were retired
  2026-06-27 — the portal mixes the six stems client-side.
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
  (`"InTheCan"`/`"Rehearse"`/`"tbd"`). Portal-side editable fields are
  `favorite` (bool) + `favorited_at` (ISO timestamp) — set via
  `PUT /api/song/:base/favorite`, used by the title-row star widget and
  the `__favorites__` pseudo-gig — and `singer_lead` itself, set via
  `PUT /api/song/:base/singer` (the in-row pulldown). The next
  `mpb_sync.py` may overwrite `singer_lead` if the band sheet still
  carries an older value; in-portal edits are intentional triage, not
  the canonical source. **Producers:** `metadata.py` (audio analysis),
  `mpb_sync.py` (Songlist fields), `server.js` (portal edits via the
  two `PUT` endpoints above). **Consumer:** `bt-construction-kit/server.js`.
  Change all of them together.
- **Version stamp**: the portal's brand chip displays a build timestamp
  derived from the newest mtime across the code files, formatted
  `V1.MMDDHHMM` (e.g. `V1.06071402`). No manual bumping — when Drive syncs
  newer files to a machine, `BOOT_VERSION` advances on the next restart.

## Player UI conventions (recent additions)

These are load-bearing — if you're touching the player surface,
respect them or update this list.

- **Per-strip boost (+5 / +10 dB).** Two small latching buttons flank
  the D routing button on every channel strip. Mutually exclusive
  3-state (off → +5 → off | off → +10 → off). Backed by
  `mixerState.boost[chan]` and multiplied into `stripGain.gain.value`
  alongside `(fader * master)`. Engaging boost does NOT change the
  fader value or recorded automation — it's a pure gain trim sitting
  on top.
- **stripGain is the single source of truth for audible level.** Do
  NOT write to `audioElement.volume` to change loudness — Chrome
  double-attenuates captured `MediaElementSource` audio (element
  volume AND downstream gain both apply), which makes the LOOPER
  appear louder than normal playback. `audioElement.volume` is
  pinned at 1.0; everything routes through `stripGain`.
- **LOOPER uses per-strip `mediaMute` GainNodes, not disconnect.**
  Chrome stops advancing `currentTime` on a `MediaElement` whose
  source has no destination, so we mute via `mediaMute.gain.value = 0`
  during a LOOPER engagement instead of calling `source.disconnect()`.
  When the LOOPER disengages we hand off back to the `MediaElement`
  by restoring `mediaMute.gain.value = 1`.
- **LOOPER generation counter.** `setupSeamlessLoop` reads a generation
  on entry and re-checks after every `await`; `tearDownSeamlessLoop`
  bumps the counter. Every `AudioBufferSourceNode` that gets created
  is added to `allLoopBufferSources` so teardown can stop ANY that
  survived an interrupted setup. Don't reintroduce single-generation
  state.
- **Click + Count-in live next to LOOPER, not in the transport row.**
  Both buttons act on the current SECTION's `clickIn` flag, not the
  whole song. The `.looper-side-btn` style keeps them visually
  accessory rather than primary transport.
- **SEMI pitch knob is quantized.** Range is `[-3, +3]` in 0.5
  increments (13 stops). Drag / wheel / -/+ stepper / arrow keys
  all snap to the half-step grid. FINE remains ±50 cents in 1-cent
  steps. Combined value is fed to `playbackRate` per stem; tempo and
  pitch are intentionally coupled (Tone.PitchShift between
  MediaElementSource and stripGain stalls the decoder, so we don't
  use it).
- **Library row columns.** Set / Title (with ☆ star) / Artist /
  Duration / Tempo / Key / Singer (pulldown) / Action (⋯ menu). The
  former `-V / -V-G / -V-G-B / DO` chip column was dropped — those
  variants are EZPerformer-only now.
- **Stars on three surfaces.** Library row title, sidebar setlist
  row, and active-track title in the player. All three read/write
  `meta.favorite` through `PUT /api/song/:base/favorite` and mutate
  the in-memory `mergedLibrary` variant so the other surfaces update
  on the next render.

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
and the processing spec); the queue runner; portal enqueue + live queue
status; `studio.sh`; library cleanup + scanner hardening against ` (N)`
duplicates; client-side six-stem mix; per-stem XR18 routing; XR18 recovery
diagnostics + snapshot log; Chrome Quick Action ingest.

Deferred / future:
- **Loop construction kit.** A new feature when needed — operator picks an
  in-song range, the app slices the six stems at beat-aligned boundaries
  and stores the result in a future per-song `loops/` directory served
  through a new endpoint. The retired `loop_detect.py` from before
  2026-06-27 is not a starting point; this will be designed fresh against
  the current six-stem-only world.
- **ActionSequence model** (task #17) — replaces the freeform Action
  buttons with a typed, editable sequence.
