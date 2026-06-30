# simpleStem regression test

When Bill says **"REGRESSION TEST"**, Claude runs this end-to-end suite
against the Performer and Librarian using computer-use / Claude-in-Chrome.
Reports back a PASS/FAIL table + a bug list.

## Pre-flight (must pass before any other step)

| ID | Test | Pass criterion |
|---|---|---|
| P1 | Chrome connected via MCP | `list_connected_browsers` returns ≥ 1 device |
| P2 | Performer server alive | `GET /api/health` returns 200 fast |
| P3 | Build stamp is recent | version chip differs from last test run |
| P4 | bt-cache populated | `GET /api/cache/status` returns running:false with done==total |
| P5 | Librarian portal alive | `GET /librarian` returns the page |

## Ingest (kick off EARLY — playback steps depend on something to play)

| ID | Test | Pass criterion |
|---|---|---|
| I1 | Drop a YouTube playlist URL | INCOMING_WEBLOC sees a new `.webloc` within 5s |
| I2 | Watcher decomposes the playlist | STEM_QUEUE has > 1 entries within 60s |
| I3 | Render starts | `/api/queue` shows `processing` non-null within 60s |
| I4 | Render completes within 15 min | New STEMS/<slug>/ folder with all 6 stems sized > 1 MB |
| I5 | metadata.json present | Title, artist, bpm, key populated |
| I6 | Stems-health endpoint sees it | `/api/librarian/stems-health` row with stemsPresent=6 |

Reference playlist for I1: `https://www.youtube.com/playlist?list=PL87YY3OyC-86tLauIcFi0T1e0kY34_nvm`
(Bill's). Use the search box in the library FIRST to pick a video from
that playlist whose slug is NOT already in the library; that's the one
to drop.

## Library browsing

| ID | Test | Pass criterion |
|---|---|---|
| L1 | Library row count matches catalog | header "Found N unique songs" matches `/api/library` length |
| L2 | Search box filters | typing "tickets" reduces rows to ones with "tickets" in title |
| L3 | Column sort | clicking Title header sorts ascending; click again → descending |
| L4 | Star/favorite toggle | clicking ☆ persists; reload page; star still filled |
| L5 | Singer pulldown | choosing Matt persists; reload; still Matt |
| L6 | Drum pattern chip | shows `120@130` (or similar) for songs that have it |

## Playback

| ID | Test | Pass criterion |
|---|---|---|
| PB1 | Click song row | song loads, audio elements get src, readyState reaches ≥ 3 within 2s |
| PB2 | Play button | pressing space or Play starts audio; visualizer animates |
| PB3 | Pause | audio stops; visualizer freezes; currentTime preserved |
| PB4 | Resume | playback continues from saved time |
| PB5 | Seek bar drag | playhead moves to clicked position; all 6 stems stay in sync |
| PB6 | Stem mute | clicking Mute on a strip silences that stem only |
| PB7 | Stem solo | Solo isolates one stem |
| PB8 | Master volume fader | drag changes audible level on all stems |
| PB9 | SEMI / FINE tempo | knob change applies to stems AND drum machine simultaneously |
| PB10 | Looper engage | playhead loops between current IN/OUT |
| PB11 | Routing buttons (→XR18, →SysOut, →D) | XR18 status probe reports active when sending |
| PB12 | Per-strip +5 / +10 boost | engaging boost audibly louder; mutex with the other |

## Drum machine

| ID | Test | Pass criterion |
|---|---|---|
| DM1 | Drum pill always visible | shown in player header regardless of song |
| DM2 | Click pill engages drum | bright green border + BPM flash animation visible |
| DM3 | Drum signal in visualizer | waveform / level meter animates while drum loops |
| DM4 | SEMI/FINE pitch changes drum tempo | engage drum, change SEMI; drum loop tempo changes |
| DM5 | Right-click context menu | shows alternates list |
| DM6 | Switching alternate | new drum file loads + plays without dropout |
| DM7 | Click pill again disengages | green border removed; backing track stays stopped (per design) |

## Setlist / Gig navigation

| ID | Test | Pass criterion |
|---|---|---|
| SL1 | Sidebar shows current gig | gig title matches `Sunday_June28` or selected |
| SL2 | Click setlist item | loads the song into player |
| SL3 | Auto-advance | after a track ends, next setlist song loads |
| SL4 | Create a new manual setlist | new entry appears under `__manual_setlists__`; persisted via POST /api/setlists |
| SL5 | Add song to manual setlist | drag or click adds; persists on reload |
| SL6 | Switch to __favorites__ pseudo-gig | shows only starred songs |
| SL7 | Switch to __recents__ | shows the songs we just clicked, newest first |
| SL8 | Switch to __round_robin__ | sequence interleaves singers |

## Librarian view

| ID | Test | Pass criterion |
|---|---|---|
| LB1 | `/librarian` loads | page renders within 2s |
| LB2 | Plumbing cards: Drive | "Live" with latency < 100 ms |
| LB3 | Plumbing cards: CATALOG.json | shape "canonical" (NOT "UNKNOWN SHAPE") |
| LB4 | Living Pipeline folder counts | INCOMING + STEM_QUEUE + STEMS counts match real disk |
| LB5 | Folders animate open / closed | folder with files shows open flap + ambient docs |
| LB6 | Arrow pulse on file movement | drop a webloc → see file glyph fly INCOMING → STEM_QUEUE |
| LB7 | Drive health checkmark | green ✓ pulses once per minute |
| LB8 | Active Tasks countdowns | drum/clip/stem precaches show mm:ss countdown ticking down once/sec |
| LB9 | Library table loads | 350+ rows with stems-health column |
| LB10 | URL drop enqueue | paste a YouTube URL + Enqueue → INCOMING_WEBLOC gets the file |
| LB11 | Stems Health filter (search by "0/6") | shows the empty/partial songs |

## Robustness checks

| ID | Test | Pass criterion |
|---|---|---|
| R1 | Click 5 different songs in 10 sec | each loads in < 2s; no toast errors |
| R2 | Page reload mid-playback | auto-restore picks up last song |
| R3 | Server restart button | "CLICK HERE TO RESTART" banner triggers restart cleanly |
| R4 | Snapshot button | feedback appears; `~/.simpleStem-catalog/snapshots/` has new entry |
| R5 | XR18 disconnect mid-test | gracefully reverts to SysOut, banner notes the change |

## Output

At the end, report:

1. A markdown table with one row per test ID, column `Status` = ✅ PASS / ❌ FAIL / ⚠️ SKIP, column `Notes` brief.
2. A bug list with severity (P0 / P1 / P2), file:line if known, and reproduction steps.
3. A separate "Questions for Bill" list — improvements requiring his input.

## Updates to this spec

Any time Claude finds a test that should have been here but wasn't, append
it under the appropriate section AND in the commit message say `regression:
add LBx`. The spec evolves with the system.
