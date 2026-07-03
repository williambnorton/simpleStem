# simpleStem — one-pager

**What**: A band backing-track system. YouTube URLs become 6-stem separations that a web portal mixes client-side. Used at live rehearsals and gigs.

**Who**: Bill (project owner, guitar+vocals) and his band (Matt, Dan, Mark on drums, occasionally JD and Joyce). Rehearses weekly; plays gigs monthly. The performer laptop travels to venues that often have no wifi.

**Why not just Spotify / SoundCloud**: The band needs per-stem control (mute vocals to sing along, kill guitar to solo over, keep drums+bass as a rhythm section). Off-the-shelf backing tracks don't offer that. Demucs's `htdemucs_6s` model gives clean separations that are good enough for live use.

## Architecture in one paragraph

Two Macs share a Google Drive folder for data. The Mac mini ("Librarian", 24/7) watches for pasted YouTube URLs, downloads audio, extracts metadata, keeps `CATALOG.json` current, and pulls a shared Google Sheet ("MPB Songlist") that the band uses as its canonical song list. The MacBook Pro ("Performer", 36 GB, travels) runs Demucs (which needs the RAM), serves the portal at `localhost:3000`, and drives an XR18 mixer + optional MIDI hardware (Helix guitar amp, Logic Pro) at gigs. Code is in GitHub, cloned to `~/simpleStem-code/` on each machine. All data (`STEMS/`, `M4A/`, `CATALOG.json`, `GIGS/`, `SETLISTS/`, `BACKING_TRACKS/`, `DRUM_MACHINE/`, `CUSTOM_LOOPS/`) lives at `~/ClaudeDrive/simpleStem/`, which the Performer mirrors to `~/.bt-cache/` for offline gig operation.

## What the portal does

- Renders a **library** of every song with title, artist, BPM, key, singer, tags, backing-mode chip, play count, "how stale" indicator.
- Groups songs into **gigs** (top-level) → **setlists** (up to 4 per gig) → **songs** (ordered). Auto-advances during playback.
- Per-song **playback mode**: full six-stem mixer, or a pre-mixed stereo backing track, or a drum machine loop only, or none (band plays it live). Mode is remembered per song across sessions.
- **Gig Builder** modal that filters the library by tonight's musicians + tags + backing modes and either lets you hand-pick songs (radios 1·2·3·4 sort into setlists) or runs an AI populate that fills setlists with round-robin singer distribution + staleness scoring.
- **Section markers** and per-song MIDI automation timeline (fires `PC` / `CC` messages at timestamps to a Python sidecar → Helix / Logic / XR18).
- Sync operations don't touch the request path; audio is served from `~/.bt-cache/` only. The gig laptop plays at venues with no wifi.

## Two-machine data flow

```
YouTube URL
  ↓ (Chrome extension, or paste into portal)
INCOMING_WEBLOC/*.webloc
  ↓ (Librarian: webloc_watch.sh)
STEMS/<slug>/source.wav  (cached forever)
STEM_QUEUE/<slug>.json   (job description)
  ↓ (Performer: queue_runner.sh → stem.sh)
STEMS/<slug>/{vocals,drums,bass,guitar,piano,other}.m4a
  ↓
bt-construction-kit portal :3000 → Chrome → XR18 → speakers
```

## Non-code assets managed as data

- `GIGS/*.json` — real gigs, `{title, source, setlists:[{title, songs:[{song_base}]}]}`
- `SETLISTS/*.json` — standalone setlists (playlist-synced OR manual)
- `BACKING_TRACKS/*.m4a` — 269 hand-mixed stereo m4a files, matched to library songs by fuzzy title+artist
- `DRUM_MACHINE/*.m4a` — 57 drum patterns named `<bpm>@<pattern>.m4a`
- `CUSTOM_LOOPS/*.m4a` — clip library for live triggering
- `CATALOG.json` — derived index over `STEMS/`, produced by `catalog.py` on the Librarian
- `RECENTS.json` — last N songs played

## Design tenets

1. **Offline-safe by default** — every playback path serves from a local mirror; Drive is only touched in background precache loops.
2. **Data is content-addressed** — song folder name is the primary key. Renaming a folder breaks references; deleting a folder frees the space.
3. **Two producers, one consumer** — the file format (m4a, moov-first, brand mp42) is enforced by both the Demucs pipeline and any manual re-stem hand-off through Logic Pro.
4. **Ingest is slow (Demucs takes 10–25 min per song); playback must be instant.** The whole architecture bends around that asymmetry.
5. **Fail loud on gig-critical paths.** Missing stems, drift between CATALOG.json shape and the live scanner, cache misses — all surface as banners, not silent fallbacks.

## Where to go next

- **New agent joining the project**: read `AGENTS.md`.
- **Codebase rules and conventions**: read `CLAUDE.md`.
- **Design and code map**: read `ARCHITECTURE.md`.
- **Recent activity**: `git log --oneline -30`.

## Contact

Bill Norton — `bill.norton@gmail.com`. GitHub: <https://github.com/williambnorton/simpleStem>.
