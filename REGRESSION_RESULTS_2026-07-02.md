# Regression test results — 2026-07-02 (evening)

Run by Claude via Claude-in-Chrome + shell against the Performer (V1.07021936).
Ingest test song: Dire Straits — Sultans of Swing (89Qg_gYqkys).

**Environment caveat (RESOLVED — root cause found):** partway through, the
media pipeline wedged globally — even a synthesized WAV blob would not load
in ANY Chrome tab (`readyState` stuck at 0, `stalled` after ~3 s, while
`fetch()` of the same URLs streamed perfectly). Chrome restart did NOT fix
it. `POST /api/audio/kick-coreaudio` fixed it instantly: **coreaudiod was
hung** (the XR18 USB-handshake failure mode). Gig-day takeaway: "no stems
responded after 3s" on every song + fetch works = kick coreaudiod, don't
debug the app. (The kick then briefly ORPHANED the XR18 to 2 ch, exactly as
the first-aid button's tooltip warns; it recovered to 18 ch on its own.)
All ⏸ rows below were re-run after the kick — final statuses shown.

## PASS/FAIL table

| ID | Status | Notes |
|---|---|---|
| P1 | ✅ PASS | Chrome MCP connected (1 device) |
| P2 | ✅ PASS | /api/health 200 in 2 ms |
| P3 | ✅ PASS | V1.07021936, built same evening |
| P4 | ✅ PASS | cache done 358/358, running:false |
| P5 | ✅ PASS | /librarian 200 |
| I1 | ✅ PASS | webloc in INCOMING_WEBLOC < 5 s (portal ingest box) |
| I2 | ✅ PASS | Librarian watcher decomposed within ~60 s |
| I3 | ✅ PASS | processing visible in header ("downloading source") |
| I4 | ✅ PASS | full render ≈ 3 min; 6 stems, mp42 + moov-first verified byte-level |
| I5 | ⚠ PARTIAL | title/bpm/key populated; artist = "RHINO" (YouTube channel) — see Q2 |
| I6 | ⚠ PASS-SLOW | stems-health showed 0/6 right after render; self-healed a few min later (bug #8) |
| L1 | ✅ PASS | "Found 357" == /api/library 357 |
| L2 | ✅ PASS | "tickets" → 1 row |
| L3 | ✅ PASS | Title sort asc/desc |
| L4 | ✅ PASS | star persisted across reload (then restored) |
| L5 | ✅ PASS | singer=Matt persisted across reload (then restored) |
| L6 | ✅ PASS | 120@130, 95@150 chips visible |
| PB1 | ✅ PASS | 6/6 stems readyState 4 in <1 s |
| PB2 | ✅ PASS | plays, currentTime advances |
| PB3 | ✅ PASS | pause freezes, position kept |
| PB4 | ✅ PASS | resumes from saved time |
| PB5 | ✅ PASS | seek → all 6 stems at 122.7 s, spread 0.000 |
| PB6 | ✅ PASS | mute vocals → stripGain 0, restores exactly |
| PB7 | ✅ PASS | solo drums isolates (others → 0) |
| PB8 | ✅ PASS | master 0.74→0.40 scales every strip (0.1×0.4=0.04 ✓) |
| PB9 | ✅ PASS | SEMI +0.5 → rate 1.0293 = 2^(0.5/12), exact quantization |
| PB10 | ✅ PASS | looper Bridge 48.1→86.4 s, wrap observed |
| PB11 | ✅ PASS | →XR18: probe isDefaultOutput:true, 18 ch; →Sys Out restores |
| PB12 | ✅ PASS | +5=×1.78, +10=×3.16, mutually exclusive, fader untouched |
| DM1 | ✅ PASS | drum pill in header for every song loaded |
| DM2 | ✅ PASS | pill engages — green glow + "DRUM MACHINE PLAYING" banner |
| DM3 | ✅ PASS | drum audio playing (120@130.m4a) |
| DM4 | ✅ PASS | SEMI change applies to drum rate too (1.0293) |
| DM5 | ✅ PASS | right-click → alternates list with CURRENT marked |
| DM6 | ✅ PASS | switched to 120@136 without dropout; session-only (metadata untouched) |
| DM7 | ✅ PASS | pill click disengages; song stays stopped per design |
| SL1 | ✅ PASS | gig picker: 9 pseudo-gigs + real gigs, current gig loaded |
| SL2 | ✅ PASS | setlist click loaded American Girl into player |
| SL3 | ✅ PASS | Communication Breakdown ended → D'yer Mak'er auto-loaded + playing |
| SL4 | ⚠ DESIGN | "Add a setlist" silently disabled in Manual Setlists pseudo-gig (tooltip says use the planner) — see Q4 |
| SL5 | ✅ PASS | ghost + committed, 6× POST /api/setlists, persisted; removal persisted too (earlier failure = coreaudiod cascade) |
| SL6 | ✅ PASS | favorites shows starred songs |
| SL7 | ✅ PASS | recents newest-first |
| SL8 | ❌ FAIL → FIXED | round-robin dropped ALL JD songs (bug #3) |
| LB1 | ✅ PASS | renders < 2 s |
| LB2 | ✅ PASS | Drive Live · 0 ms |
| LB3 | ✅ PASS | CATALOG.json 358 rows · canonical |
| LB4 | ✅ PASS* | counts consistent with APIs; CUSTOM_LOOPS shows 17 vs boot-log "16 clips" — see Q3 |
| LB5 | ✅ PASS | folders with files show open flap + ambient docs |
| LB6 | ⚠ SKIP | needs a live file-move to observe the arrow pulse |
| LB7 | ✅ PASS | DRIVE OK · 0ms · ticking timestamp |
| LB8 | ✅ PASS | countdown cards ticking with progress bars |
| LB9 | ✅ PASS | 359 rows with stems-health column |
| LB10 | ⚠ CODE | same /api/enqueue path proven end-to-end via I1; librarian box not separately exercised (avoids duplicate render) |
| LB11 | ❌ FAIL → FIXED | "0/6" search returned "no songs match" (bug #7) |
| R1 | ✅ PASS | 5 rapid song loads, 253–946 ms each, no error toasts |
| R2 | ✅ PASS | reload mid-playback → same song restored, plays on next gesture |
| R3 | ❌→✅ VERIFIED FIXED | pre-fix: server killed, never returned. Post-fix: back in <25 s on the correct build |
| R4 | ⚠ PASS-QUIET | POST /api/debug/snapshot → 200, but no visible feedback (spec wants "feedback appears") |
| R5 | ⚠ OBSERVED | didn't yank USB, but the full degrade/recover cycle happened live: kick-coreaudio → "XR18 ORPHANED · 2 ch" red banner (correct detection, output stayed SysOut) → self-recovered to "XR18 ACTIVE · 18 ch out" |

## Bug list

| # | Sev | Where | Bug | Status |
|---|---|---|---|---|
| 1 | **P0** | `server.js` /api/restart + /api/update (~4078) | Restart runs `performer.sh` from the DATA root (`~/ClaudeDrive/simpleStem`) — a stale Drive copy — instead of the git clone the server runs from. Observed: server killed, never came back. Mid-gig this is fatal. | **FIXED** — `resolveRestartScript()` prefers the clone next to `__dirname`, falls back to data root |
| 2 | **P1** | `server.js:1860` `rebuildBackingTrackAssignments` | `libCache is not defined` (variable is `libraryCache`, songs live at `.data.songs`). Backing-track precache crashed at boot EVERY boot → backing tracks never assigned/cached → offline-gig contract broken for every backing-track-mode song. | **FIXED · verified live** |
| 3 | **P1** | `app.js:1102` `loadRoundRobinGig` | `lead[0].toUpperCase()+lead.slice(1).toLowerCase()` turns "JD" into "Jd" → JD's whole bucket silently dropped from RoundRobin. Confirmed live: 16 first songs = Bill/Matt/Dan only. | **FIXED** — lookup map |
| 4 | **P1** | `app.js` heartbeat (~5230) | False "SERVER NOT RESPONDING — CLICK HERE TO RESTART" banner while /api/health answered in 2 ms. Stale state was inferred from *absence of successful polls*, which Chrome's background-tab timer throttling produces on its own. Combined with bug #1, clicking the false banner would have killed a healthy server mid-gig. | **FIXED** — banner now requires a heartbeat that actually failed more recently than the last success; silent-timer case fires an immediate probe instead |
| 5 | P2 | `stem.sh` source branch | Drive-sync race: job JSON (small) reaches the Performer before the Librarian's `source.wav` (~50 MB) → Performer re-downloads from YouTube → Drive keeps both → `source (1).wav` litter + double YouTube traffic. Observed live on Sultans render. | **FIXED** — bounded wait (default 90 s, `SIMPLE_STEM_SOURCE_WAIT` to tune/disable) for the Librarian's copy before self-downloading |
| 6 | P2 | `queue_runner.sh` `finish()` | When a job file was already consumed elsewhere, a 0-byte marker was written into `_failed/` → portal failedRenders count inflated by unparseable ghosts (observed: successful Sultans render bumped failedRenders 3→4 at the exact done-timestamp). Strong evidence of a SECOND queue_runner racing (see Q1). | **FIXED** — no marker on absent-job failures; added Performer-only hostname guard (`SIMPLE_STEM_FORCE_RUNNER=1` to override) |
| 7 | P2 | `librarian.html` renderLibrary filter | Stems Health not searchable — "0/6" → "no songs match" (spec LB11). | **FIXED** — search now matches `present/total` and missing stem names |
| 8 | P2 | server stems-health cadence | Freshly rendered song shows 0/6 (all stems "missing", blank title) until the next periodic recompute. Suggest: recompute the affected row when the runner finishes (e.g. on `_done` change or STEMS mtime bump). | OPEN — small follow-up |
| 9 | P3 | player UI | After a song-load failure the player collapses to an empty white shell (no title bar, no transport). Cosmetic but disorienting; the failure toast disappears with it. | OPEN |
| 10 | P3 | `webloc_watch.sh` title_artist() | Artist = YouTube uploader/channel when no music-artist tag ("RHINO", "vtha sangkulh", "HAAKIE48" in tonight's data). Code comment says the "Artist - Title" split was removed deliberately per your preference. | BY DESIGN — see Q2 |
| — | ENV | Chrome (machine-wide) | Media pipeline wedged: no `<audio>` element in any tab would load anything, incl. a generated WAV blob. `fetch()` fine, files verified mp42/faststart. Cleared by restarting Chrome. Worth remembering as a gig-day first-aid item: this exact state produces "no stems responded after 3s" for every song. | Chrome restart |

## Questions for Bill

1. **ANSWERED — yes.** `ps aux` on the mini showed `queue_runner.sh` running since Wednesday 1 PM (pid 21279), and its hostname is `Librarian.local` (the new guard matches it). **Action on the mini:** `kill 21279`, then `git pull` so the guarded queue_runner + stem.sh source-wait land there. `librarian.sh` does not manage queue_runner, so nothing else will respawn it.
2. **Artist naming:** keep uploader-as-artist (predictable, current design), or add a conservative "Artist - Title" split that only fires when the title contains " - " AND the uploader is not one of the two sides? Tonight it produced artist "RHINO" for Sultans of Swing.
3. **CUSTOM_LOOPS shows 17 files but clip precache reports 16 clips** — probably one non-m4a straggler in the folder; worth a look.
4. **SL4 UX:** in the Manual Setlists pseudo-gig, "Add a setlist" looks clickable but silently does nothing (it's disabled with only a hover tooltip pointing to the planner). Want a visible hint or an enabled button that creates an empty standalone setlist there?
5. **Vocals strip** was absent from the mixer for "25 or 6 to 4" (5 strips) but present for "Sweet Home Alabama" (6). If that's the per-song "V" toggle persisting — fine; if not, worth a second look.
