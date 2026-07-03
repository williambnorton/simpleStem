# For AI coding agents joining the project

**Read `CLAUDE.md` first.** It's the operating manual — machine-role split, file format policy, naming conventions, gotchas that will bite you. Everything below points into other docs; this file is the map.

## What this project is

A band backing-track system. YouTube URLs → 6-stem Demucs separations served through a web portal that mixes them client-side. Live band uses it at rehearsals and gigs.

- **Front-end**: Express server + vanilla JS at `bt-construction-kit/` (no build step, no framework)
- **Ingest pipeline**: bash + Python scripts at the root (`webloc_watch.sh`, `stem.sh`, `metadata.py`, `catalog.py`, `mpb_sync.py`, `queue_runner.sh`)
- **Two machines**: a **Librarian** (Mac mini, 24/7, ingests) and a **Performer** (MacBook, gigs, plays). They share a Google Drive folder as data storage; code lives in GitHub.
- **Data folder**: `~/ClaudeDrive/simpleStem/` on both machines (`STEMS/`, `M4A/`, `GIGS/`, `SETLISTS/`, `BACKING_TRACKS/`, `DRUM_MACHINE/`, `CUSTOM_LOOPS/`, `CATALOG.json`, `RECENTS.json`)

## Where to find things

| I want to understand… | Read |
|---|---|
| Rules the codebase expects agents to follow | `CLAUDE.md` |
| Design, data contracts, code map, endpoints | `ARCHITECTURE.md` |
| End-to-end flow diagram | `WORKFLOW.md` |
| How a bandmate uses the app | `USER_GUIDE.md` (may not exist yet) |
| Keyboard shortcuts + KM integration | `SHORTCUTS.md` |
| How to smoke-test the whole thing | `REGRESSION_TEST.md` |
| Detailed prompts for other AIs | `prompts/` |

Before writing code, skim `CLAUDE.md`'s "Which machine runs what" table and the "Conventions" section — those two answer most "why is this like this?" questions.

## Non-negotiables

Copied here so you can't miss them; the source of truth is `CLAUDE.md`.

1. **m4a only, moov-at-front, brand `mp42`.** Any m4a producer writes AAC 256k with `+faststart -brand mp42`. Chrome silently stalls on the default `isom` brand — this caused a gig failure on 2026-06-28. The only exception is `source.wav` in each `STEMS/<slug>/`.
2. **Cache-first, offline-safe.** Every song's 6 m4a stems must be in `~/.bt-cache/STEMS/` at all times. The portal is expected to work at venues with no wifi. Any code path that does a sync Drive read (`fs.existsSync`, `fs.statSync`, `fs.readdirSync`) in a hot request handler is a bug — CPU-blocks Node's single-threaded event loop when Drive is unreachable.
3. **Every command block Claude writes says which machine to run on** — "on the Performer" or "on the Librarian". The routing table is in `CLAUDE.md` under "Which machine runs what."
4. **Long-running scripts emit timestamped progress with ETA every ~30 min.** Canonical shape in `CLAUDE.md`.
5. **`#` comments never appear inside a zsh code block** meant for the user to copy-paste. zsh defaults to `no_interactive_comments` and the `#` becomes a positional arg. Put explanation in prose outside the block.
6. **Node event loop must stay unblocked.** All Drive reads use `fsp.readdir` + a 1.5–3 s `Promise.race` timeout. See the "no synchronous Drive reads" gig postmortem in `CLAUDE.md`.

## Currently in-flight (be careful editing these areas)

As of 2026-07-02:

| Area | Files | Status |
|---|---|---|
| **Gig Builder** | `bt-construction-kit/public/app.js` (bottom IIFE, look for `initGigBuilder`), `server.js` `POST /api/gig-builder/build`, `styles.css` (`.gb-*` classes) | Shipped, tested, working. Ripping out legacy library-row checkbox column + ghost `+N` batch flow + template picker is still todo — see task #134 in the task list. |
| **Backing tracks** | `server.js` `BACKING_TRACKS_DIR`, matcher `normalizeForMatch`, manifest at `BACKING_TRACKS/manifest.json` | Shipped. Live-version noise stripping + shared-file assignments + persistent manifest all working. See task #130 for optional polish (mostly done). |
| **Per-song playback mode** | `PUT /api/song/:base/playback-mode`, client `refreshBackingTrackPick`, `playback_mode` field on `metadata.json` | Shipped. Defaults to `6STEMS`. Auto-engages the remembered mode on song load. |
| **KBM logic-restem macro** | Pending edit on the user's Keyboard Maestro side. Server emits `simpleStem_StemDir` + six explicit file paths. Macro needs updating to consume them. | See task list #131 discussion. |

The task list (visible to Claude in this repo's driver) has full context on each. If you're picking up work, ask which task ID you're on before you touch code.

## How to run it locally

Two shells, one per machine role. Both machines share `~/ClaudeDrive/simpleStem/`.

**Librarian (Mac mini)**:
```
cd ~/simpleStem-code
./librarian.sh start
./librarian.sh status
```

**Performer (MacBook)**:
```
cd ~/simpleStem-code
(cd bt-construction-kit && npm install)
./performer.sh start
./performer.sh status
```

Portal serves at `http://localhost:3000`.

## Safe exploration checklist

If you're new to the codebase and want to poke around without breaking anything:

1. Run `./performer.sh status` — see what's up.
2. `curl -s http://localhost:3000/api/library | python3 -c "import json, sys; d = json.load(sys.stdin); print(f\"{len(d['songs'])} songs\")"` — confirm the library loads.
3. Read `CLAUDE.md` end to end.
4. Read `ARCHITECTURE.md`'s "End-to-end pipeline" section.
5. Read the endpoint table in `ARCHITECTURE.md`.
6. Look at `bt-construction-kit/server.js` top-to-bottom (it's a single flat Express file, easy to navigate).
7. Look at `bt-construction-kit/public/app.js` `initGigBuilder` IIFE at the bottom — most recent addition, good example of how a client feature is structured.
8. `git log --oneline -30` — recent commits tell you what's been touched lately.

## Making changes

- Work on a branch. `.git/` lives inside a Drive-synced folder — see `CLAUDE.md`'s "Git & sync" section for the lock-file quirks.
- After editing, always: `node --check bt-construction-kit/server.js && node --check bt-construction-kit/public/app.js`.
- `./sync_to_drive.sh` copies code changes into `~/ClaudeDrive/simpleStem/bt-construction-kit/` so a Drive-mirroring machine sees them.
- `./performer.sh restart` picks up server changes; a Cmd+Shift+R in Chrome picks up client changes.

## Concurrent-agent coordination

If more than one agent is working at once:

- The **primary Claude session** (the one the user is actively directing) owns the task list.
- Before writing to a file, `git status` + a quick `git diff HEAD` — if there are uncommitted changes you didn't make, someone else is mid-edit; back off.
- Prefer proposing a diff or a design doc first when the user hasn't approved the change; unrequested rewrites of `app.js` or `server.js` will collide with in-flight work.
- Everything in the "Currently in-flight" table above is actively being worked. Ask before touching.

## Anti-patterns learned the hard way

- **Sync Drive reads in hot endpoints** wedge the event loop offline. 2026-06-28 gig failure.
- **m4a without `+faststart -brand mp42`** stalls Chrome's `<audio>`. 2026-06-28 gig failure.
- **Connection: close** on `/api/audio/*` also stalls Chrome. 2026-06-29 fix.
- **Same slug in two setlists / gigs** is fine (files are content-addressed by folder name); duplicating the folder is the bug.
- **`git commit -m 'msg with !'`** — zsh history expansion kills the commit. Use `git commit -F <file>` with a heredoc. See memory notes.
- **Long shell paste blocks with `#` comments** — zsh eats them as args. Prose goes outside the block.
