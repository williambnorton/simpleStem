# Regression results — 2026-07-04 (full phased regimen, first run)

Executed per REGRESSION_TEST.md v2 against Performer build V1.07040958.
Ingest test song: Warren Zevon — Werewolves of London (c6M89iDabwM).

## PASS/FAIL

| ID | Status | Notes |
|---|---|---|
| ST1–ST5 | ✅ | all syntax gates clean; tree had only the spec edit |
| P1–P6 | ✅ | health 6 ms · build current · cache 350/350/0 · precache log clean |
| P7 | ✅ | blob WAV canplaythrough in 3 ms — audio stack healthy |
| I1 | ✅ | webloc queued < 2 s |
| I2–I3 | ✅ | job queued + demucs phase within ~60 s |
| L1–L6 | ✅ | 349==349 · search · sort · star/singer persisted + restored · drum chips |
| PB1 | ✅ | 6/6 stems ready in 297 ms |
| PB2–PB5 | ✅ | play/pause/resume; seek spread 0.000 s across 6 stems |
| PB6–PB8 | ✅ | mute exact-restore · solo isolates · master scales all strips |
| PB9 | ✅ | SEMI ½-step = 1.02930 (2^(1/24)) · FINE 1 cent = 1.000578 · restored |
| PB10 | ✅ | via LC2 |
| PB11 | ✅ | →XR18 →SysOut round-trip, health 200 throughout, ends on speakers |
| PB12 | ✅ | +5=×1.78 · +10=×3.16 · mutex · clean off |
| SRC1–SRC6 | ✅ | pills indicate + blink correctly; transport drives the drum source; stop=pause+rewind armed; 6 STEMS returns, rehydrates 6, persists mode |
| SRC7 | ✅ | single-lane waveform while drum engaged (seen in-frame with the alternates menu) |
| SRC8 | ✅ | full parity on the backing track |
| DM1–DM7 | ✅ | engage/banner/audio/SEMI-coupling/alternates (CURRENT marked)/switch (metadata untouched)/disengage |
| LC1 | ✅ | engage drift 0.02 s |
| LC2 | ✅ | playhead wraps 48.1→30.2, stays inside Chorus |
| LC3 | ✅ | disengage jump 0.01 s beyond wall-clock |
| LC4 | ✅ | loop rate 1.0595 == media rate with SEMI +1 |
| LC5 | ✅ | waited 667 ms for fresh onsets; 4 clicks at 0.458 s ending 1 beat before the 0.158 s downbeat; audio entered on "5" |
| SL1–SL3 | ✅ | picker/pseudo-gigs · setlist click loads · auto-advance American Girl→Higher Ground |
| SL4 | ⚠ | manual-setlist creation lives in the planner (by design); not re-exercised |
| SL5 | ✅* | verified same-day via real clicks (morning run: add + persist + remove). The synthetic-click path no-ops in automation — noted in craft notes, not an app bug |
| SL6–SL8 | ✅ | favorites 19 · recents newest-first · RoundRobin B→M→D→JD with all 21 JD songs |
| GR1 | ✅ | rename round-trip incl. slug + picker; disabled on pseudo-gigs |
| LB1–LB5, LB7–LB9 | ✅ | Drive 1–2 ms · catalog 350 canonical · counts 351/57/17 · NEWEST captions with full filenames · countdowns ticking · health table 351/351 complete |
| LB6 | ⚠ | captions + legend verified; the in-flight glyph animation wasn't observed this run (render completed before the page was opened) |
| LB10 | ⚠ | same endpoint as I1 (proven); librarian box not separately fired to avoid a duplicate render |
| LB11 | ✅ | "0/6" correctly matches nothing — the library is 100% complete (351/351) |
| LB12 | ✅ | **all 7 daemons green via Drive heartbeat with real PIDs on Librarian.local** |
| LB13 | ✅ | proven behaviorally: the mini pulled today's commits and restarted itself unattended (fresh PIDs, new services present) |
| SYS1 | ✅ | restart round-trip < 20 s, correct build |
| SYS2 | ✅ | snapshot 200 (still no visible feedback — known gap) |
| SYS3 | ✅ | wifi endpoint {en0, on:true}, pill mirrors; radio flip left to operator |
| SYS4 | ✅ | perf-caffeinate pid live |
| R1 | ✅ | 5 rapid loads 483–1591 ms (5th flagged only by a too-short probe window; confirmed loaded 6×rs4), zero failure marks |
| R2 | ✅ | reload at 45.9 s mid-playback → same song restored |
| R4 | ✅ | failed-renders list + clear exercised (cleared the false Werewolves entry) |
| R5 | ⚠ | observational only; board stayed ACTIVE 18 ch all run |
| I4–I6 | ✅ | 6/6 stems 39 MB · bpm 104 G major · health row complete |
| OC1 | ✅ | cache 351/351, 0 failed (new song included) |
| OC2 | ✅ | audio hot path clean (local-cache statSync only; drum list memory-only) |
| OC3 | ✅ | TWO drills same day. (1) offline_regression.sh 180s: health ≤1 ms throughout, 3×36-song audio sweeps clean (worst 62 ms), 7 endpoints error-free, log clean — PASS 0 warnings. (2) Interactive 221 s wifi-off gig drill via in-page driver: 5 setlist songs played + advanced, pause/resume/seek, drum + backing engaged with transport control per source, stop=rewind-armed, 6 STEMS returns ×3, setlist add persisted server-side OFFLINE then removed, looper engage/disengage, 8-song soak, health worst 3 ms offline, dead-man wifi restore worked. 25/25 core steps PASS (5 soak flags were a stale-DOM harness artifact — all 4 songs verified loading 158–779 ms after) |

**Score: 59 ✅ · 4 ⚠ (design/observational) · 0 ❌ open** — OC3 completed later same day, twice.

## Bugs found this run

| Sev | What | Status |
|---|---|---|
| P1 | **Demucs separated directly onto the Drive CloudStorage mount** — Drive yanked `htdemucs_6s/source/` mid-write (`avio_open failed`, torchcodec), first Werewolves attempt landed in `_failed` even though nothing was wrong; a second job copy succeeded. | **FIXED** — stem.sh now separates into a local scratch dir (`$TMPDIR/simplestem_demucs_$$`) and moves finished stems to Drive in one pass. Takes effect next render, no restart needed. False `_failed` entry cleared via the triage API. |
| P3 | Artist still derives from the YouTube uploader ("RHINO") | by design (standing question) |
| P3 | Snapshot has no visible feedback | open, cosmetic |

## Questions for Bill
1. The 4 remaining `_failed` entries (In the Evening, CSN Woodstock, Canned Heat, TLC Waterfalls) await your retry/clear at `/failed-renders.html` — In the Evening apparently rendered fine later (it's in the library), so its entry is probably the same Drive-race class the stem.sh fix now prevents.
2. OC3 (wifi-off drill) remains yours — a good moment is right after the short USB cable arrives.
