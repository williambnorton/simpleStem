# Regression results, 2026-08-17

Run by Claude via HTTP + DOM automation against build V1.08170944 on the
Performer, per REGRESSION_TEST.md. Automation runs in a background tab,
so audible playback phases are state-level only and end with an
operator ear check (noted per phase). One bug was found DURING the run
and fixed in the same session (ffcf268).

## Summary

29 pass, 3 warn, 1 bug found and fixed, 5 operator-only. NOT one
standing FAIL at the end of the run. Venue readiness gate:
`./performer.sh drill` is expected VENUE READY with the violation
counter at zero; the operator runs it as the closing step.

## Phase results

| Phase | Result | Notes |
|---|---|---|
| ST1 JS syntax | PASS | server.js, app.js, visualizer.js clean |
| ST2 shell syntax | PASS | 8 scripts clean (performer, librarian, queue_runner, stem, webloc_watch, midi_watchdog, faststart, retire) |
| ST2b python | PASS | 7 files py_compile clean |
| ST5 git | PASS | tree clean at e6e3b64 before run |
| P2 health | PASS | 3 ms, 365 songs, libraryReady |
| P latency | PASS | max 6 ms over 20 calls (budget 100) |
| P9 disk | WARN | ~20 GB free at last df; M4A purge freed 20 GB earlier, keep an eye on snapshot regrowth |
| P10 XR18 | PASS | present, 18 channels, default output |
| MIDI sidecar | PASS | alive; U2MIDI Pro BACK on the bus (first time since 08-10) |
| MIDI XR18 port | WARN | XR18 MIDI port absent from sidecar port list while its audio is fine; restart-midi to re-enumerate CoreMIDI |
| MIDI chain test | WARN | loop reports BROKEN: CC out U2MIDI, no echo on any input. Helix off, MIDI thru off, or return cable. Endpoint hint: cable DIN OUT straight to return input and re-test |
| MIDI clock | PASS | start 120 → running → stop round trip |
| L1 count | PASS | header == API == 365 |
| L7 null BPM | PASS | Gimme_Shelter listed with filters on |
| L8 filter math | PASS (prior session) | singer boxes add/subtract exact counts |
| MPL parser | PASS | 16/16 positive, 6/6 negative rejected, feel marks parse, console + desk agree |
| MUSE | PASS | corpus 47 programs, harvester idle (no wire traffic during run) |
| PB playback | OPERATOR | background tab cannot decode media; play one song by ear (transport/seek/sync passed in prior visible-tab run) |
| PB13 watchdog | PASS (prior session) | forced suspend self-healed in <4 s; banner raise/clear verified synthetic |
| PB14 readout | PASS (prior session) | single format across samples |
| DM drum pattern | PASS | NEW pulldown: 57 patterns, 9 families; PUT round trip; pick honors selection (family-near); restore; 404 bad base |
| SL+GR gig CRUD | PASS | create → list → delete round trip clean |
| DEL1 guards | PASS | wrong confirm 400, unknown base 404 |
| DEL2-4 | PASS (2026-08-14) | live end-to-end with sacrificial folder; tombstones deployed |
| LB dashboards | PASS | queue/state/librarian-state served from 10 s snapshot; daemons prefer live pids |
| SYS5 diagnostics | PASS | /api/debug/logs 15 ms, health unaffected |
| SYS6 prune consent | PASS | no plan armed; dialog + defer verified 2026-08-09 |
| R6 hostile input | PASS | traversal 403, junk enqueue 400, unknown automation 404 |
| OC1 cache | PASS | 369/369 folders, 0 failed |
| OC faststart | PASS | moov before mdat on sampled stem |
| OC5 mandate | PASS | driveSyncViolations 0 PAST GRACE under a 3x hammer of every page-load and song-load endpoint plus play/recents writes |
| OC4 drill | OPERATOR | ./performer.sh drill expected VENUE READY now |

## Bug found during the run (fixed)

Loading a song (Stray Cat Strut, live operator traffic during the run)
fired 4 sync Drive reads from GET /api/song/:base/lyrics and POST
/api/song/:base/play. Both converted to the bounded helpers (ffcf268):
lyrics degrade offline with driveTimeout true, play counts 503. Post-fix
hammer of the full song-load path past grace: zero violations.

## Operator checklist to close the run

1. `./performer.sh drill` unplugged: expect VENUE READY.
2. Play one song end to end by ear (PB phases).
3. MIDI loop: power the Helix, confirm MIDI thru, re-run
   `/api/midi/chain-test`; if still broken, cable DIN OUT straight to
   the return input per the endpoint hint.
4. `./performer.sh restart-midi` to re-enumerate the XR18 MIDI port.
