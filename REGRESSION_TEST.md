# simpleStem regression test — the full regimen

When Bill says **"REGRESSION TEST"**, Claude runs this end-to-end suite
against the Performer and Librarian using computer-use / Claude-in-Chrome,
and reports a PASS/FAIL table + a bug list. Results files are named
`REGRESSION_RESULTS_<date>.md`.

## Phases and rationale

The order is deliberate. Four principles:

1. **Cheapest checks first, fail fast.** Static gates take seconds and catch
   code rot before any UI work. A syntax error found in Phase 0 saves an
   hour of confused browser testing.
2. **Environment before features.** The July 2–4 wedges proved that a hung
   coreaudiod makes EVERY feature test fail with misleading symptoms. Phase
   1 must pass — especially P7 — before any playback result is meaningful.
3. **Overlap the slow path.** A Demucs render takes minutes. Kick ingest off
   in Phase 2, test everything else while it cooks, verify the result at
   the end (I4–I6).
4. **Mutating and system-level tests last, with restoration.** Anything that
   writes metadata gets restored (stars, singers, modes). Anything that
   recycles processes (restart round-trip) runs after the feature suites so
   a restart bug can't invalidate them. Destructive/physical tests (Wi-Fi
   radio flip, kick-coreaudiod, USB replug) are OPERATOR-ONLY — automation
   must never sever its own control channel or degrade the rig.

| Phase | Suite | Why it exists |
|---|---|---|
| 0 | ST — static gates | catch broken code before touching the app |
| 1 | P — pre-flight environment | nothing else is meaningful if this fails |
| 2 | I1–I3 — ingest kick-off | start the slow path early |
| 3 | L — library | the operator's main navigation surface |
| 4 | PB — playback core | the reason the app exists |
| 5 | SRC — playback sources & mode pills | transport must control what's sounding |
| 6 | DM — drum machine | live rehearsal workhorse |
| 7 | LC — looper & count-in | practice tools; historically skip-prone |
| 8 | SL + GR — setlists, gigs, rename | gig-night navigation |
| 9 | LB — librarian dashboard | curation visibility + pipeline truth |
| 10 | SYS — system controls | restart, snapshot, Wi-Fi, caffeinate |
| 11 | R — robustness | rapid-fire and recovery behavior |
| 12 | I4–I6 + OC — ingest completion & offline contract | the gig guarantee |

## Phase 0 — Static gates (ST)

| ID | Test | Pass criterion |
|---|---|---|
| ST1 | JS syntax | `node --check` clean on server.js, app.js, visualizer.js |
| ST2 | Shell syntax | `bash -n` clean on performer.sh, librarian.sh, queue_runner.sh, stem.sh, webloc_watch.sh, autoupdate_librarian.sh, librarian_heartbeat.sh |
| ST3 | Inline HTML JS | librarian.html script blocks parse (`new Function`) |
| ST4 | Catalog conformance | server boot log has no `[catalog-conformance] DRIFT` |
| ST5 | Git hygiene | working tree state known; no unexpected foreign edits |

## Phase 1 — Pre-flight environment (P)

| ID | Test | Pass criterion |
|---|---|---|
| P1 | Chrome connected via MCP | `list_connected_browsers` returns ≥ 1 device |
| P2 | Performer server alive | `GET /api/health` returns 200 fast |
| P3 | Build stamp is current | version chip matches newest code mtime; no Update chip pending |
| P4 | bt-cache populated | `GET /api/cache/status` running:false, done==total, failed==0 |
| P5 | Librarian portal alive | `GET /librarian` returns the page |
| P6 | Boot precaches all succeeded | perf-server.log has no `precache] failed:` line |
| P7 | Media pipeline sane | a generated WAV blob reaches `readyState ≥ 3` in < 2 s in a throwaway `Audio()`. **If this fails, STOP and run the first-aid ladder (docs/postmortem_hangs.pdf) — no playback result below is meaningful.** |
| P8 | Gig test verdict (added 2026-08-14) | `./performer.sh test` prints GIG READY (exit 0). One command covering services, health latency budget, offline cache sample, faststart, XR18, sidecar, disk, power |
| P9 | Disk headroom (added 2026-08-14) | `df -k` shows ≥ 20 GB TRULY free on the Data volume. Finder's number includes purgeable and lies: the 2026-08-09 15 GB state evicted Drive files, failed 8 renders, and wedged coreaudiod |
| P10 | XR18 audio function alive (added 2026-08-14) | `/api/audio/xr18-status`: present AND channels > 0. Present with 0 channels = the mixer's USB audio engine crashed: POWER-CYCLE THE XR18 (Mac reboot re-enumerates the same half-dead device). Absent = cable/power |

## Phase 2 — Ingest kick-off (I1–I3)

Reference playlist: `https://www.youtube.com/playlist?list=PL87YY3OyC-86tLauIcFi0T1e0kY34_nvm`.
Search the library FIRST and pick a video whose slug is NOT already present;
if all are present, pick any well-known song absent from the library.

| ID | Test | Pass criterion |
|---|---|---|
| I1 | Drop a YouTube URL (portal ingest box) | INCOMING_WEBLOC sees a new `.webloc` within 5s |
| I2 | Watcher decomposes | STEM_QUEUE gains an entry within ~90s (Drive sync included) |
| I3 | Render starts | `/api/queue` shows `processing` non-null (or header chip shows the job) |

## Phase 3 — Library (L)

| ID | Test | Pass criterion |
|---|---|---|
| L1 | Row count matches API | header "Found N" == `/api/library` length |
| L2 | Search filters | typing "tickets" reduces to matching rows |
| L3 | Column sort | Title asc on first click, desc on second |
| L4 | Star persists | toggle ☆, reload, still ★ — then restore |
| L5 | Singer pulldown persists | set Matt, reload, still Matt — then restore |
| L6 | Drum chip | `120@130`-style chip renders for songs that have it |
| L7 | Null-BPM visibility (added 2026-08-14) | a song with bpm null and no tempo tag stays listed with every filter checkbox checked (2026-08-10: a cache-rebuilt song vanished through both tempo buckets) |
| L8 | Filter arithmetic (added 2026-08-14) | unchecking a singer box drops "Found N" by exactly that singer's count; re-checking restores the full count |

## Phase 4 — Playback core (PB)

| ID | Test | Pass criterion |
|---|---|---|
| PB1 | Song load | 6 stems reach readyState ≥ 3 in < 2s |
| PB2 | Play | audio starts; currentTime advances |
| PB3 | Pause | freezes; position preserved |
| PB4 | Resume | continues from saved time |
| PB5 | Seek | all 6 stems land on the target, spread < 0.05s |
| PB6 | Mute | stripGain → 0 for that stem only; restores exactly |
| PB7 | Solo | isolates one stem (others → 0) |
| PB8 | Master fader | scales every strip (fader × master) |
| PB9 | SEMI/FINE | half-step quantized (2^(n/24)); FINE ±1 cent; restores |
| PB10 | Looper wrap | playhead cycles inside the section (see LC too) |
| PB11 | Routing | →XR18 probe reports isDefaultOutput true; →Sys Out restores |
| PB12 | Boosts | +5 = ×1.78, +10 = ×3.16, mutually exclusive, fader untouched |
| PB13 | Wedge watchdog self-heal (added 2026-08-14) | with a song playing, `audioCtx.suspend()` from the console: playhead resumes within ~4 s (stage-1 heal), no banner. Synthetic 5-stall drive of `audioWedgeWatchdog` raises the red banner; one moving sample clears it |
| PB14 | Readout single-format (added 2026-08-14) | while playing, #time-current stays `m:ss` across 10 samples at 200 ms; no `00:00`-style flash from a second writer |

## Phase 5 — Playback sources & mode pills (SRC) — added 2026-07-04

Rationale: the transport must control whatever is audible; the pills are the
operator's only mode indicator at a dark gig.

| ID | Test | Pass criterion |
|---|---|---|
| SRC1 | 6 STEMS pill present | renders in the meta row |
| SRC2 | Stems mode indication | playing stems → stems pill `mode-active` + blinking `mode-playing` |
| SRC3 | Drum engage indication | drum pill blinks; stems pill goes quiet |
| SRC4 | Transport controls drum | Play pauses/resumes the DRUM element; stems untouched |
| SRC5 | Stop on drum | pause + rewind to 0; drum stays engaged and armed |
| SRC6 | Return to stems | 6 STEMS pill click disengages drum/backing, rehydrates 6 stems, persists mode 'stems' |
| SRC7 | Single-lane visualizer | drum/backing engaged → ONE waveform lane, not six copies |
| SRC8 | Backing parity | SRC3–SRC6 hold for the backing track when the song has one |

## Phase 6 — Drum machine (DM)

| ID | Test | Pass criterion |
|---|---|---|
| DM1 | Pill always visible | shown regardless of song |
| DM2 | Engage | green glow + BPM flash + banner |
| DM3 | Drum audio flows | element playing, correct file |
| DM4 | SEMI couples | drum playbackRate follows the knob |
| DM5 | Right-click menu | alternates list with CURRENT marked |
| DM6 | Switch alternate | new file plays without dropout; session-only (metadata untouched) |
| DM7 | Disengage | pill dims; song stays stopped (explicit-gesture design) |

## Phase 7 — Looper & count-in (LC) — added 2026-07-04

| ID | Test | Pass criterion |
|---|---|---|
| LC1 | Engage no-skip | audible position continuous at engage |
| LC2 | Playhead follows loop | media currentTime wraps at section end back to start (≤0.3s drift) |
| LC3 | Disengage continuity | position right after ≈ right before (wall-clock delta only) |
| LC4 | Rate-matched loop | with SEMI ≠ 0, loop buffers play at the media rate |
| LC5 | Count-in schedule | with count-in on + fresh start: waits for onset table (log line), 4 clicks land one beat apart ending one beat before the first downbeat; audio enters on "5" |

## Phase 8 — Setlists, gigs, rename (SL + GR)

| ID | Test | Pass criterion |
|---|---|---|
| SL1 | Sidebar shows current gig | picker + title match |
| SL2 | Click setlist song | loads into player |
| SL3 | Auto-advance | song end → next setlist song plays |
| SL4 | Create manual setlist | via planner; appears under `__manual_setlists__` |
| SL5 | Ghost-add | loaded song's green + commits to the open setlist; persists via POST /api/setlists; removal persists too |
| SL6 | `__favorites__` | only starred songs |
| SL7 | `__recents__` | newest first |
| SL8 | `__round_robin__` | Bill→Matt→Dan→JD interleave, all four buckets drained |
| GR1 | Gig rename | pencil button renames; slug + picker + sidebar follow; disabled on pseudo-gigs; restore after |

## Phase 8b — Song deletion (DEL) — added 2026-08-14

Test with a sacrificial folder (ZZ_TEST_DELETE_ME pattern), never a real song.

| ID | Test | Pass criterion |
|---|---|---|
| DEL1 | Confirm guard | wrong confirm 400, missing confirm 400, unknown base with no library row 404; target song untouched after all three |
| DEL2 | Performer cleanup | after DELETE with correct confirm: Drive STEMS folder gone, `~/.bt-cache/STEMS/<base>` gone, `~/.bt-cache/LOOPSESS/<base>` gone, matching M4A + caches gone, library row gone immediately |
| DEL3 | No ghost resurrection | after a catalog mirror reload (stale CATALOG.json still listing the song), the deleted row stays gone (tombstone filter). Repeat DELETE on the already-deleted base returns ghostRowCleared when a stale row exists |
| DEL4 | Librarian propagation | OPERATOR: within a few minutes of Drive sync, `ls STEMS | grep <base>` on the mini is empty; the next catalog pass drops the row from CATALOG.json |

## Phase 9 — Librarian dashboard (LB)

| ID | Test | Pass criterion |
|---|---|---|
| LB1 | `/librarian` loads | renders < 2s |
| LB2 | Drive card | "Live" with low latency |
| LB3 | CATALOG.json card | canonical shape, plausible row count |
| LB4 | Pipeline folder counts | match API/disk truth |
| LB5 | Folders animate | open flap + ambient docs when non-empty |
| LB6 | Filename flights | file glyph + FULL filename travels the arrow on movement; NEWEST captions per stage |
| LB7 | Drive health tick | timestamped ✓ updates |
| LB8 | Active Tasks countdowns | mm:ss ticking |
| LB9 | Library health table | all songs with stems column; search works |
| LB10 | URL-drop enqueue | Enqueue button feeds INCOMING_WEBLOC |
| LB11 | Stems-health search | "0/6" filters to empty/partial; missing stem names match too |
| LB12 | Daemon heartbeat cards | green with "pid N on <host> · hb Ns ago" when the mini's heartbeat file is fresh; red with stale-age otherwise (added 2026-07-04) |
| LB13 | Auto-update evidence | `.code-version` marker on Drive matches origin/main after mini pull cycle (added 2026-07-04) |

## Phase 9b — Librarian daemon staleness (added 2026-08-14)

| ID | Test | Pass criterion |
|---|---|---|
| LB-S1 | Heartbeat freshness | no Librarian service heartbeat older than 24 h on the dashboard. Found 2026-08-14: entries at 4 d and 15 h while everything looked green at a glance. Stale mpbsync = sheet edits silently not landing |

## Phase 10 — System controls (SYS) — added 2026-07-04

| ID | Test | Pass criterion |
|---|---|---|
| SYS1 | Restart round-trip | POST /api/restart → server back < 30s on the correct build (this IS old R3) |
| SYS2 | Snapshot | POST fires 200 (visible feedback is a known gap) |
| SYS3 | WIFI pill | GET /api/system/wifi returns device + state; pill mirrors it. Radio FLIP is operator-only — automation must not cut its own control channel |
| SYS4 | Caffeinate service | perf-caffeinate pid alive while performer.sh runs |
| SYS5 | Diagnostics stay async (added 2026-08-14) | `/api/debug/logs` answers < 5 s AND `/api/health` stays < 100 ms during it. Its first version's sync Drive reads blocked the event loop and hung page loads (2026-08-10) |
| SYS6 | Consent-gated prune (added 2026-08-14) | `/api/cache/prune-pending` reports null or an armed plan; `prune-execute` with no plan removes 0 files; a synthetic `showPruneDialog` plan renders stats + countdown, and DEFER deletes nothing. The cache must never delete without the 30 s dialog |

## Phase 11 — Robustness (R)

| ID | Test | Pass criterion |
|---|---|---|
| R1 | 5 songs in 10s | each < 2s, no error toasts |
| R2 | Reload mid-playback | last song auto-restores; Play resumes |
| R4 | Failed-render triage | /failed-renders.html lists; retry/clear work |
| R5 | XR18 degrade/recover | ORPHANED banner on bad enumeration; recovers or SysOut fallback (observational — do NOT yank USB in automation) |
| R6 | Hostile input battery (added 2026-08-14) | path traversal on `/api/audio/stems` → 403; garbage/empty `/api/enqueue` → 400; bad song ids on favorite/singer PUTs → 404; automation GET for a nonexistent song → 404 (was 200 with fabricated defaults, found 2026-08-14) |

## Phase 12 — Ingest completion & offline contract (I4–I6 + OC)

| ID | Test | Pass criterion |
|---|---|---|
| I4 | Render completes | new STEMS/<slug>/ with 6 stems > 1 MB |
| I5 | metadata.json | title/artist/bpm/key populated |
| I6 | Health row | stemsPresent 6/6 within one health pass |
| OC1 | Cache complete | /api/cache/status done==total, failed==0 (incl. the new song after precache) |
| OC2 | Hot-path audit | no sync Drive reads in /api/audio handlers; sendCachedAudio cache-first with bounded Drive race |
| OC3 | Physical offline drill | OPERATOR: `./offline_test.sh 60` on the Performer + play/advance/drum during the window |
| OC4 | Venue drill (added 2026-08-16) | OPERATOR: `./performer.sh drill` unplugged: wifi off, full gig test passes, every page-load/song-load endpoint answers < 2 s offline, reset round-trip recovers < 30 s offline, wifi restored. Born from the 2026-08-16 gig where sync Drive reads in recents + automation wedged the portal solid and reset could not save it |
| OC5 | Bounded Drive metadata I/O (added 2026-08-16) | no sync fs calls on Drive metadata in any request path: automation GET/PUT, action-sequences GET, pitch PUT go through readMetaBounded/writeMetaBounded (1.5 s read / 5 s write race), reads degrade with driveTimeout:true, writes 503. RECENTS.json lives on LOCAL disk, never Drive |

## Output

1. Markdown PASS/FAIL table, one row per ID (✅/❌/⚠/⏸), brief notes.
2. Bug list: severity (P0/P1/P2), file:line, repro steps, FIXED/OPEN status.
3. "Questions for Bill" — judgment calls needing the operator.

## Execution craft notes (learned the hard way)

- Re-query DOM elements fresh after every re-render; cached NodeLists go stale.
- Stub `window.prompt/confirm/alert` BEFORE clicking `+ CLIP`, `+ ACTION`,
  `CLEAR`, duplicate/delete — native dialogs freeze CDP automation.
- Restore every mutation: stars, singer, playback_mode, drum alternate,
  gig titles, test setlist entries.
- Never flip Wi-Fi off or kick coreaudiod from automation; never leave
  playback running between phases.
- The player collapses on load failure — a P7 re-check beats confusion.

## Updates to this spec

When a test should have existed but didn't, append it under its phase AND
say `regression: add <ID>` in the commit message. The spec evolves with the
system.
