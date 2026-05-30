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

This project runs across two Macs that both mount the same Google Drive folder
(`~/ClaudeDrive/simpleStem`). Their roles are **not** interchangeable:

| Machine | Drive mode | Role | Runs |
|---|---|---|---|
| **Acquisition Mac** (smaller, 8 GB) | **mirrors** Drive (local copy) | Ingest + render + serve live | `studio.sh` → `webloc_watch.sh`, `queue_runner.sh`, the portal, and Demucs |
| **Studio Mac** (larger) | **streams** Drive (no local mirror) | Evolve the UI | edits to `bt-construction-kit/` + docs; `node server.js` for local UI testing only |

Why this split:

- **Demucs and yt-dlp write gigabytes** (downloads, stems). That must happen on
  the machine that *mirrors* Drive locally; doing it on the streaming machine
  would push GBs back over the network and be slow/expensive.
- **The 8 GB machine is memory-tight.** Demucs + Chrome + an agent already hit
  "out of application memory." So heavy *UI/agent* work moves to the larger
  machine, while the acquisition machine focuses on the pipeline + serving.
- **UI work is light I/O** (editing JS/HTML/CSS, reading small files), which is
  fine over a streamed Drive.

### If you are the Claude on the Studio (UI) Mac

- **Do** edit `bt-construction-kit/` (server.js, public/*) and the docs.
- **Do** validate changes locally: `node --check bt-construction-kit/server.js`,
  `node --check bt-construction-kit/public/app.js`, and run just the UI with
  `cd bt-construction-kit && node server.js` (it can read stems streamed from
  Drive, slowly).
- **Don't** run `webloc_watch.sh`, `queue_runner.sh`, `stem.sh`, or Demucs here
  — that's the acquisition machine's job and would thrash the streamed Drive.
- **Don't** change the `metadata.json` schema without also updating
  `metadata.py` (the producer) on the acquisition side — see Conventions.

### If you are the Claude on the Acquisition Mac

- Own the pipeline: `studio.sh start` runs the watcher, runner, and portal.
- Treat `bt-construction-kit/` as owned by the Studio Mac; pull its changes via
  git rather than editing in parallel.

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

## Running it (acquisition machine)

```
cd ~/ClaudeDrive/simpleStem
(cd bt-construction-kit && npm install)   # once
./studio.sh start        # server + watcher + runner
./studio.sh status       # state + queue depth + current render & phase
./studio.sh logs runner  # tail a service
./studio.sh stop
```

Add a song from the portal's "Add from YouTube" box (or drop a `.webloc` into
`INCOMING_WEBLOC/`). Render phases show in the portal and in `status`:
`downloading source → analyzing (BPM/key) → separating stems · demucs → mixing
m4a`. Demucs is ~10–25 min/song on CPU; that's expected — a new request just
queues behind the current song.

## Conventions

- **Slug**: lowercase, spaces → `_`, drop anything but `[a-z0-9_-]`. Song files
  are `<slug>.json`; setlist entries are `NN_<slug>.json` (zero-padded order).
- **M4A naming**: `<Title>_<Artist>_<suffix>.m4a`, suffix ∈ `-V`, `-V-G`,
  `-V-G-B`, `DO`; no suffix = full mix ("FULL"). The library scanner ignores
  ` (N)` duplicate copies.
- **metadata.json** (the contract between producer and consumer): `title`,
  `artist`, `source_url`, `version`, `duration_sec`, `clip_start_sec`,
  `clip_end_sec`, `bpm`, `key`, `key_signature`, `lyrics_search_url`,
  `chords_search_url`, `processing{download,separation,mixdowns}`, and for
  setlist members `playlist_title` + `sequence_number`. **Producer:**
  `metadata.py`. **Consumer:** `bt-construction-kit/server.js`. Change both
  together.

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
