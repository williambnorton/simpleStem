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
  for setlist members `playlist_title` + `sequence_number`. **Producer:**
  `metadata.py`. **Consumer:** `bt-construction-kit/server.js`. Change both
  together.
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
