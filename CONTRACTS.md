# simpleStem — contracts (invariants) reference

The set of promises the simpleStem codebase makes to itself. Each row is a rule that has either been documented in `CLAUDE.md`, encoded in code, or written into the persistent-memory feedback set. Where a rule has a dated symptom, that date traces to a real incident whose postmortem is documented in `CLAUDE.md`.

**Reading conventions.**

- **ID** — short slug for referencing in commits, PRs, code review, and other docs. New rules pick the next free number in their category.
- **Contract** — the actual promise, one sentence.
- **Enforced at** — the file, endpoint, or discipline where the rule lives. Not always a code check; sometimes it's operator discipline via `CLAUDE.md`.
- **Broken → symptom** — what has (or would) happen if the rule is violated. Dated entries trace to real incidents.

If you're adding a new invariant, add a row here **in the same PR** as the code change that introduces it. If a row goes stale, mark it retired; don't delete history.

Sibling docs:
- `CLAUDE.md` — long-form rules and postmortems.
- `ARCHITECTURE.md` — how everything fits together.
- `AGENTS.md` — quick start for new AI agents.
- `PROJECT.md` — one-pager for humans who've never seen the codebase.

---

## 1. Machine role

Two-machine architecture. Neither role is interchangeable.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **M-1** | Librarian NEVER runs Demucs. Demucs needs several GB RAM; 8 GB mini crashed. | `performer.sh` + `librarian.sh` service lists | "Out of application memory" crash. *Pre-May 2026, before role split.* |
| **M-2** | Performer NEVER runs `webloc_watch` or `catalog.py`. Ingest lives on the always-on Librarian. | `performer.sh` SERVICES list omits watcher/cataloger | Two catalogs racing to `CATALOG.json` produce shape drift. |
| **M-3** | Only ONE `queue_runner.sh` at a time (single `mkdir` lock on `STEM_QUEUE/.runner.lock`). | `queue_runner.sh` `mkdir "$LOCK"` guard | Two runners racing → duplicate stem writes, corrupted m4a. |
| **M-4** | Git operations NEVER on both machines concurrently. Drive-synced `.git` can corrupt. | Manual discipline + `CLAUDE.md` "Git & sync" | `.git/index.lock` hangs. Documented recovery in `CLAUDE.md`. |
| **M-5** | Every command block Claude writes says which machine to run on ("On the Performer" or "On the Librarian"). Two blocks always presented, even when one has only a status command. | Memory feedback `feedback_machine_routing_explicit` | Operator confusion, wrong-machine execution, wasted time at gigs. |

## 2. Offline gig survival

The Performer must play at wifi-free venues. Absolute rules.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **OFF-1** | Every song's six m4a stems live in `~/.bt-cache/STEMS/` at all times. No "warming phase." If a song is in `/api/library`, it's ready. | `precacheAllStemsM4a` at boot + hourly + Flash Cache | "Song failed to load" at downbeat. *2026-06-28 gig failure.* |
| **OFF-2** | No synchronous Drive reads in ANY hot endpoint. `fs.existsSync` / `fs.statSync` / `fs.readdirSync` on a Drive path wedges Node's event loop offline. | `sendCachedAudio`, `listDrumPatterns`, `reconcileLibrarianFolders` all use `fsp` + `Promise.race(1.5–3 s)` | Portal freezes for 30+ s including scroll, audio, MIDI. *2026-06-28 gig + 2026-07-05 practice scroll-lockup.* |
| **OFF-3** | Audio request path serves `~/.bt-cache` only. Cold-cache falls to Drive via 3 s bounded probe → 503 rather than block. | `sendCachedAudio` in `bt-construction-kit/server.js` around line 1329 | Same as OFF-2. |
| **OFF-4** | `Connection: close` is NEVER on `/api/audio/*`. Chrome media element stalls at `networkState=2/readyState=0` for 3+ s. | Explicitly commented out in `server.js` audio middleware | "No stems responded after 3s" toast. *2026-06-29 fix.* |
| **OFF-5** | `CATALOG.json` is read from a LOCAL mirror at `~/.simpleStem-catalog/CATALOG.json`. Drive is never in the request path even for the library scan. | `refreshLibraryCache` mirror-first path | Library click hangs while Drive `stat` runs. |
| **OFF-6** | Precache failure is LOUD. Boot precache errors surface as a banner, not silent fall-through. | `precacheAllStemsM4a` error branch | Silent partial cache → songs fail silently at gig. |
| **OFF-7** | Flash Cache button (mixer header) forces full re-precache. Shift-click forces overwrite. | `POST /api/cache/flash` + `GET /api/cache/status` | Operator has no way to pre-warm before leaving for a gig. |

## 3. Audio file format

Every m4a producer writes the same shape. Chrome is picky.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **F-1** | All audio output is m4a. WAV, MP3, FLAC forbidden downstream of ingest. Only exception: `source.wav` in each `STEMS/<slug>/` (the 48 kHz reference). | `stem.sh`, Logic re-stem KBM macro, `CLAUDE.md` policy | Silent decoder failure on some browsers. |
| **F-2** | Every m4a is AAC 256k. No other bitrates. | `ffmpeg -c:a aac -b:a 256k` in `stem.sh` | Sound quality drift; band notices at rehearsal. |
| **F-3** | `moov` atom at FRONT (fast-start). `ffmpeg -movflags +faststart`. | `stem.sh` + `faststart_m4a.sh` retrofit script | Chrome `<audio>` stalls waiting for entire file to download. *2026-06-28 gig failure.* |
| **F-4** | `ftyp` major brand = `mp42`. Default `isom`/`iso2` is rejected by Chrome. | `ffmpeg -brand mp42` in `stem.sh` | Silent stall, no error. *2026-06-29 root-cause.* |
| **F-5** | Stem file names are canonical: `vocals.m4a drums.m4a bass.m4a guitar.m4a piano.m4a other.m4a`. Six files, no others. | `stem.sh` loop over these six names + KBM macro | Portal can't locate stems; library shows 0/6 present. |
| **F-6** | Per-stem `.wav` files after transcode are deleted (opt out via `KEEP_STEM_WAVS=1`). | `stem.sh` cleanup block | Disk waste. `cleanup_stems_wav.py` backfill exists. |
| **F-7** | Legacy mixdowns (`_-V`, `_-V-G`, `_-V-G-B`, `_DO`) are RETIRED. Don't produce, don't consume. | `retire_legacy_files.sh` + `.M4A.retired-2026-06-27/` marker | Producers still writing them waste disk; consumers wired to them break when removed. |

## 4. Data contracts — producer / consumer

Any file both machines read must have exactly one producer and every reader must agree on the shape.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **D-1** | `CATALOG.json` row shape agreed byte-for-byte between `catalog.py` (Librarian producer) and `scanStems` (Performer consumer). | `runCatalogConformanceCheck` at boot logs `[catalog-conformance] DRIFT` | Songs render missing metadata fields. *Task #89 saga.* |
| **D-2** | `metadata.json` owned by `metadata.py` + `mpb_sync.py` + `server.js` PUT endpoints. Change all producers + the consumer (`server.js`) together in the same PR. | `CLAUDE.md` "Conventions" section | Silent field drops; UI shows blank singer/key/etc. |
| **D-3** | Setlist song entries use `song_base`, not `slug`. `mpb_sync.py` writes both for backward compat; client normalizes on load. | `normalizeGigSongBases` at gig-load site (task #126) | "Song not in library" toast for 100% of MPB gig setlists. *2026-07-01 gig failure.* |
| **D-4** | Slugs are ASCII alphanumeric plus `_` and `-`. Spaces to underscore, punctuation dropped. | `slugify` helper in `stem.sh` + `webloc_watch.sh` + `lib-common.sh` | Slug mismatch between `webloc_watch` and `stem.sh` → renders land in wrong folder. |
| **D-5** | Gig files (`GIGS/<slug>.json`) with `source: "mpb_sync"` AND `_ignored: true` are preserved by `mpb_sync.py` on re-sync (soft-delete). | `mpb_sync.py` post-sync check (task #132) | Sheet-synced gig re-appears on every sync. Deletes look broken. |
| **D-6** | Playlist-origin setlists (`SETLISTS/<slug>.json` with `origin: "playlist"`) refuse `DELETE` with 409. | `DELETE /api/setlists/:slug` 409 branch | User deletes; `setlist_sync.py` restores; user thinks it's a bug. |
| **D-7** | Portal-editable fields (`favorite`, `tags`, `singer_lead`, `readiness`, `playback_mode`, `band_required_compact`, `key_short`, `drum_machine_default`) are stored on the same `metadata.json`, not a sidecar. | All `PUT /api/song/:base/*` endpoints | Sidecar files drift; snapshot/restore misses them. |
| **D-8** | `BACKING_TRACKS/manifest.json` wins over auto-matcher. Manual assignments persist across restart. | `rebuildBackingTrackAssignments` layers manifest last | Every server restart forgets curator's manual overrides. |

## 5. UI conventions — player + gig hierarchy

Load-bearing rules the client code assumes about itself.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **UI-1** | `stripGain` is the single source of truth for audible level. `audioElement.volume` pinned at 1.0. | Player init in `app.js`; never write to `element.volume` | Chrome double-attenuates `MediaElementSource` → LOOPER louder than playback. |
| **UI-2** | LOOPER mutes stems via per-strip `mediaMute` `GainNode` (`gain = 0`), not `disconnect()`. Disconnected sources stop advancing `currentTime` in Chrome. | `setupSeamlessLoop` / `tearDownSeamlessLoop` | LOOPER stops; timeline frozen. |
| **UI-3** | LOOPER carries a generation counter; every `AudioBufferSourceNode` registers to `allLoopBufferSources` for cleanup. | `setupSeamlessLoop` generation check on each `await` | Zombie loop sources continue playing after teardown. |
| **UI-4** | Gig → Setlist → Song hierarchy is the ONLY playback grouping. Sidebar mirrors it; URLs follow it; files follow it. | `activeGig` / `activeSetlistIdx` / `gigPlayingSongIdx` state | Divergent hierarchies produce ambiguous "current position." |
| **UI-5** | Default backing mode is `6STEMS`. Auto-engages remembered mode from `metadata.playback_mode` on song load. | `loadSong` → `refreshDrumMachinePick` + `refreshBackingTrackPick` | Song loads in wrong mode → operator hears drum machine when they expected stems. |
| **UI-6** | Sections editable in `6STEMS` + `BACKING` modes only. `DRUM` has no structure; `NONE` has no visualizer. | Visualizer gating (task #132 design) | Section markers placed on a drum loop mean nothing. |
| **UI-7** | 4/4 time signature assumed throughout. `loop_detect` + KBM `Bars` computation both hard-code four beats per bar. | `stem.sh` Bars formula + `loop_detect.py` | 3/4 and 6/8 songs get wrong bar counts (audio is correct). |
| **UI-8** | Version stamp on the brand chip is derived from newest code-file mtime, formatted `V1.MMDDHHMM`. Never manually bumped. | `BOOT_VERSION` computed at server start | Version confusion; can't tell which build is running. |
| **UI-9** | The lyrics overlay follows the playhead in BOTH directions. Every seek — click on visualizer, drag, section-jump, keyboard nudge — flows through `seekAllAudioTo`, which calls `syncLyricsToPlayhead(seconds)` to reconstruct the visible lyric burst at the target time (last `replace` at/before target, plus intervening `append`s). New seek paths must call `seekAllAudioTo`, never `currentTime =` directly. | `visualizer.js` `seekAllAudioTo` → `window.syncLyricsToPlayhead` | Scrub past a line and the overlay stays blank until playback re-crosses the event — operator can't tell where they are in the lyric flow. |
| **UI-10** | The `+ Lyric` button is a two-state UI: `remaining > 0` → `+ Lyric (N)` in `mode-place`; `remaining === 0 OR no lyrics file` → `Fetch Lyrics` in `mode-fetch`, click opens the editor directly (no confirm). Both states are derived from `lyricsState.cachedLines.length - lyricsCursor()`. | `_refreshLyricButtonLabel` + `onLyricTap` | Old confirm ("All N lines placed — re-open?") pops for empty / all-headers lyrics files and interrupts placement flow. |

## 6. Shell + paste blocks

The user pastes into iTerm/zsh. These rules keep paste-blocks safe.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **SH-1** | `#` comments are FORBIDDEN inside any zsh paste block. Explanation goes in prose outside the block. | Memory feedback `feedback_no_inline_shell_comments` | zsh `no_interactive_comments` treats `#` as literal → command breaks silently. |
| **SH-2** | Each paste block starts with two echoes: `commandSet created HH:MM` and `` CommandSet Executed on `hostname` on `date` ``. | Memory feedback `feedback_command_set_stamps` | Multi-machine, multi-iteration pastes get confused in scrollback. |
| **SH-3** | Git commit messages containing `!` use heredoc + `git commit -F`, never `-m`. zsh history expansion fires before git runs. | Memory feedback `feedback_git_commit_heredoc_for_bangs` | `zsh: event not found`, commit aborts. |
| **SH-4** | `python3 -c '...'` never contains escaped double quotes (`\"`). Use `python3 - <<'PY' ... PY` for anything that needs both quote kinds. | Memory feedback `feedback_python_dash_c_quoting` | Python `SyntaxError` on the backslash. |
| **SH-5** | Long-running scripts (faststart, precache, backfills) print timestamped progress with ETA at least every 30 min. Canonical shape in memory. | Memory feedback `feedback_progress_lines` | Operator can't tell if a 3-hour run is stuck or still working. |

## 7. MIDI + external hardware

Interfaces to the Helix, XR18, and Logic Pro.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **EX-1** | `midi_sidecar` matches port names by case-insensitive substring. `"helix"` hits `"Helix Native"` / `"HX Stomp"` / etc. | `midi_sidecar.py` port resolver | Hardware ID mismatches break automation. |
| **EX-2** | MIDI events are Program Change or Control Change, one-shot. No ramps. | Client → `POST /api/midi/send` + sidecar | Continuous fader rides not supported by design. |
| **EX-2a** | Amended 2026-07-30: automation events are still one-shot and latched, but a **sustained region** may be expressed as an on/off event PAIR whose live value is a **pure function of song time** — never a state machine. Same construction as the click track (`clickStateAt`); `ampRotateStateAt`/`ampRotateStepAt` follow it. | `startAmpRotateScheduler()` in `app.js`, separate from the 33 Hz latched dispatcher | A stateful sustained event desyncs on every seek, loop wrap and pause, and there is no correct way to resync it. |
| **EX-3** | Logic Pro re-stem KBM macro is triggered NON-BLOCKING via `open kmtrigger://macro=simpleStem`, not `osascript do script`. | `/api/song/:base/logic-restem` spawn detached | 120 s AppleEvent timeout kills the 180 s macro every time. |
| **EX-4** | `simpleStem_Running` KBM variable is the SINGLE source of truth for "macro is busy." Server sets atomically along with the song's vars; macro clears at exit (success + error paths). Escape: `POST /api/logic-restem/unlock`. | `osascript` setup + macro cleanup | Stuck lock → next re-stem returns 409 until manual reset. |
| **EX-5** | Core Audio device detection matches `default && output`, NOT `default && audio`. Playback vs UI-sounds devices are separate keys. | Memory feedback `feedback_coreaudio_default_keys` | System-flag bleeds across devices; wrong device selected. |
| **EX-6** | When XR18 goes silent but probes say `"18 ch active default"`, power-cycle the board. Kick-coreaudio can't help — the USB endpoint is hung. | Memory feedback `feedback_xr18_usb_hang` | Chased wrong layer for hours before power-cycle fix. |
| **EX-7** | The XR18 has **no Main L/R → bus send**. Main L/R is a sink; a bus mix is built from CHANNEL sends (`/ch/NN/mix/0M/level`, valid for ch 01-16). "Put Main L in aux 1" = raise ch 1's send into bus 1. There is **no** per-send on/off on X-Air (`/ch/NN/mix/0M/on` is X32-only) — level alone is sufficient. | `amp_matrix()` in `midi_sidecar.py`; `docs/14_XR18_CONTROL.md` | Implementing the obvious mental model writes paths the board ignores — silent no-op that looks like a network fault. |
| **EX-8** | An OSC write is only believed once it **reads back** the fader float it should have produced. `ok: true` from `/xr18/set` means the datagram left, nothing more — the discovery cache holds an address for 5 min, so a power-cycled board still accepts `sendto` and answers nothing. **Sole exception:** rotation ticks (`fast: true`) skip readback because 48 verified writes is 96 round trips and cannot fit in a tick; entry and exit are verified, and each tick re-sends the whole matrix so a dropped datagram self-corrects. | `amp_apply()` verifies every write and aborts on the first mismatch | Silent successes: UI reports a program, board never moved. The RESET direction leaves six wedges live while the desk looks idle. |
| **EX-9** | `localStorage['simpleStem.ampProgram.v1']` (`{program, step}`) is a **cache**, not truth — a snapshot recall or power cycle moves the sends behind the app's back. `GET /api/xr18/amp-program` asks the board and is the reconciliation path. `'?'` (partial walk) and `'custom'` (board in no known program) must never render as "off". | `amp_state()`; `reconcileAmps()` on desk load + after snapshot recall | Desk shows an idle AUX object over six hot wedges. |
| **EX-10** | Before trusting an amp program, check `/config/buslink/N-M`, `/config/chlink/1-2` and `/config/linkcfg/fdrmute`. A linked pair makes a write to one send **also write its partner**, so the opposite-side OFF write is clobbered by its own partner — and `amp_apply` still PASSES verification, because it reads back the very path it wrote. | `amp_preflight()`; surfaced on desk load and in both right-click menus | The L/R spread silently collapses (verified against a linked board: `lr-odd-even` reports 48/48 verified while the board is actually in `reset`). |
| **EX-11** | An amp program is a **complete** state of the send matrix — all 8 sources (ch 1-2, 11-16) x 6 buses — never an incremental edit. | `amp_matrix()` returns all 48 cells | Switching programs leaves stray sends: split-by-stem after all-on leaves Main L/R still in the wedges, doubling everything. |

## 8. MPB Sheet sync

Google Sheet integration constraints.

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **MPB-1** | Sheet must be shared as "Anyone with the link can view." `gviz` CSV endpoint requires no OAuth. | `mpb_sync.py` fetch via public `/gviz/tq` | 403 from Google Sheets; sync silently fails. |
| **MPB-2** | `mpb_sync.py` NEVER auto-creates `STEMS/` folders, NEVER enqueues renders. Unmatched rows → `LOGS/mpb_sync_report.json`. | `mpb_sync.py` main loop | Would create ghost slugs the pipeline can't render. |
| **MPB-3** | Match threshold is 0.88 fuzzy on title + artist for ambiguous cases; below that, unmatched. | `SequenceMatcher` ratio in `mpb_sync.py` | False matches assign wrong singer/band metadata. |

## 9. Legal + environment

| ID | Contract | Enforced at | Broken → symptom |
|---|---|---|---|
| **ENV-1** | YouTube downloading is against TOS. Personal band-practice use only. Not to be redistributed. | Documented in `CLAUDE.md` constraints | Legal risk if used commercially. |
| **ENV-2** | `SIMPLE_STEM_ROOT` resolves in order: env var → `~/ClaudeDrive/simpleStem` → `~/Library/CloudStorage/GoogleDrive-*/My Drive/ClaudeDrive/simpleStem`. Different usernames need the env var set. | `server.js` `SIMPLE_STEM_ROOT` resolver + `performer.sh` env | Server can't find data folder; hard 500 at boot. |
| **ENV-3** | Demucs install via `pipx` with library injections: `pipx install demucs; pipx inject demucs torchcodec librosa soundfile mido python-rtmidi`. | `install.sh` | Missing libs → `stem.sh` crashes at `section_detect` or `midi_sidecar`. |
| **ENV-4** | Logic Pro 12 Stem Splitter produces SIX stems (V/D/B/G/P/O), not four. Older docs describe Logic 11 output — don't trust them. | Memory feedback `feedback_logic_pro_stem_count` | Design decisions based on 4-stem assumption break under Logic 12. |

---

## Adding a new contract

When you add a new rule:

1. Pick the right category (or add one at the bottom if none fit).
2. Assign the next unused ID in that category (e.g. `OFF-8` if you're adding an offline-gig rule after `OFF-7`).
3. Write the contract as ONE sentence. If you need two sentences, either split the rule or shorten it — long rules don't survive.
4. Name the exact file, function, or endpoint where the rule is enforced. "Manual discipline" is acceptable only when the rule targets Claude behavior or human operator behavior (see the `M-5`, `SH-*` rows).
5. Fill in the historical symptom — even if speculative. "Would race" is fine when there hasn't been a real incident yet.
6. Cross-reference from `CLAUDE.md` if the rule needs the fuller "why."

## Retiring a contract

Don't delete rows. Change the row prefix to `RETIRED-<original-ID>` and add a `Retired:` line to the contract cell explaining when and why. History matters — future agents need to see what USED to be a rule and why it stopped being one.

## Meta-contract

**This file is a contract too.** If you introduce a new invariant without adding a row here, that's a bug. If a row here contradicts the code, the code is the source of truth and this file needs a fix. Neither side is allowed to drift silently.
