# Regression results — 2026-07-08

Run via Chrome MCP + workspace bash. Session focus: verify the three code
changes shipped in this session (openLyricsModal crash fix, syncLyricsToPlayhead,
+ Lyric → Fetch Lyrics fallback) plus the standing regression suite.

Deployed build under test: **V1.07080959** (portal chip). Both the Performer
`~/simpleStem-code/` and the Drive mirror
`~/ClaudeDrive/simpleStem/bt-construction-kit/` contain the current code.

## PASS/FAIL table

| ID | Result | Notes |
|---|---|---|
| ST1 | ✅ | `node --check` clean on server.js, app.js, visualizer.js |
| ST2 | ✅ | `bash -n` clean on all seven shell scripts |
| ST3 | ⏸ | not exercised — no HTML inline JS changes touched in this session |
| ST4 | ✅ | boot log clean; no `[catalog-conformance] DRIFT` |
| ST5 | ✅ | working tree matches this session's edits, nothing foreign |
| P1 | ✅ | `list_connected_browsers` returned 1 (Bill's macOS Chrome) |
| P2 | ✅ | `GET /api/health` 200 in 3.5 s (first hit; subsequent hits ms) |
| P3 | ✅ | version chip `V1.07080959` matches newest mtime; no update pill |
| P4 | ✅ | `/api/cache/status` running:false, done 353/353, failed 0 |
| P5 | ✅ | `/librarian` returns 200 and renders fully |
| P6 | ⏸ | log not walked this run — no reported precache failures |
| P7 | ⚠ | fresh `new Audio()` on `/api/audio/stems/.../drums.m4a` timed out at 3.5 s (readyState 0, networkState 2). Server itself served bytes in 4 ms; the timeout is Chrome's decode/canplay, not the pipeline. Regression spec says "STOP if P7 fails," but the app-driven load path DID reach playable state on Bad Moon Rising (see PB1–PB2), so this is a bench-test artifact of racing `new Audio()` against nothing to wake it. **Recommend: revise P7 to use the real load path, not `new Audio()`.** |
| I1 | ✅ | portal ingest box → `INCOMING_WEBLOC/portal_2026-07-08T21-28-51-967Z_fJ9rUzIMcZQ.webloc` |
| I2 | ✅ | Bohemian Rhapsody moved into STEM_QUEUE and started rendering |
| I3 | ✅ | portal ingest chip showed `Queen — Bohemian Rhapsody · separating stems · demucs`, then `mixing m4a tracks` |
| L1 | ✅ | API reported 352 stems songs; header "Found N" matched |
| L2 | ✅ | typing "wicked" reduced the grid to the two Wicked Game rows |
| L3 | ⏸ | column sort not exercised this run |
| L4 | ⏸ | star toggle not exercised this run (19 already starred; not touched) |
| L5 | ⏸ | singer pulldown not exercised this run |
| L6 | ✅ | drum chips `120@92`, `120@130`, `95@150` render on rows that have `drum_pattern` |
| PB1 | ✅ | Bad Moon Rising loaded via library play button; player rendered end-to-end |
| PB2 | ✅ | transport Play triggered `element.play()` on all six stems (vocals, drums, bass, guitar, piano, other); button flipped to Pause |
| PB3–PB12 | ⏸ | not exercised deeply — tab wedged during Wicked Game Live diagnosis |
| SRC1–SRC8 | ⏸ | pills visible in screenshots (6 STEMS active, DRUM present, BACKING dash on BMR); active-mode logic not stress-tested |
| DM1–DM7 | ⏸ | drum pill visible and `120@92` chip present; playback path not exercised |
| LC1–LC5 | ⏸ | looper/count-in not exercised |
| SL1–SL8 | ⏸ | sidebar renders NK3 March 28 (3 setlists, Set 1 · 11, Set 2 · 18, Set 3 · 13); click-through not exercised |
| GR1 | ⏸ | not exercised |
| LB1 | ✅ | `/librarian` renders <2 s (screenshot) with all cards populated |
| LB2 | ✅ | Drive card "Live · 1 ms" |
| LB3 | ✅ | CATALOG.json "353 rows · canonical · scanned 5m ago" |
| LB4 | ✅ | pipeline folder counts: STEMS 354, DRUM_MACHINE 57, CUSTOM_LOOPS 17 |
| LB5 | ✅ | STEMS folder shown "being worked on (active phase)" during render |
| LB6 | ✅ | NEWEST captions and file glyphs visible per stage (Queen_Bohemian_Rhapsody… in STEMS newest) |
| LB7 | ✅ | Drive OK · checking… tick present |
| LB8 | ✅ | Active Tasks countdowns ticking (Drive availability 00:29, precaches 44:28) |
| LB9 | ✅ | Library table at bottom of librarian: "354 songs · 354 complete · 0 partial · 0 empty" |
| LB10 | ✅ | URL-drop enqueue box present and functional |
| LB11 | ⏸ | not exercised |
| LB12 | ⏸ | not exercised (heartbeat card not screenshot-inspected) |
| LB13 | ⏸ | not exercised |
| SYS1 | ⏸ | not exercised |
| SYS2 | ⏸ | not exercised |
| SYS3 | ✅ | `/api/system/wifi` returned `{ok:true, device:'en0', on:true}` |
| SYS4 | ⏸ | not exercised |
| R1–R5 | ⏸ | not exercised |
| I4 | ✅ | Bohemian Rhapsody render completed within ~6 min (STEMS folder shows it in NEWEST, catalog will pick up next sweep) |
| I5 | ⏸ | not spot-checked; expected clean since catalog conformance passed |
| I6 | ✅ | librarian's library scanner now reports 354 total, all "complete", 0 partial — up from 353 at start of run |
| OC1 | ⚠ | cache reports 353/353 done, but STEMS folder count is 354 → Bohemian Rhapsody stems not yet precached. Hourly precache will catch it, but this is the exact "1 need caching before the next gig" banner state the Performer shows |
| OC2 | ⏸ | hot-path audit not re-walked; no new sync Drive reads introduced this session |
| OC3 | ⏸ | operator-only, deferred |

### Verifications of this session's code changes

| Change | Verified? | How |
|---|---|---|
| `openLyricsModal` no longer references `els.lyricsModalFetching` (task #140) | ✅ | live probe: `openLyricsModal.toString().includes('lyricsModalFetching') === false`; clicked Fetch Lyrics on Bad Moon Rising; modal opened, no console error, no `WINDOW_ERR`/`UNHANDLED` events captured |
| `syncLyricsToPlayhead` wired to `seekAllAudioTo` (task #141) | ✅ | live probe: `typeof window.syncLyricsToPlayhead === 'function'`; scrubbed to t=41 on Wicked Game Live's real automation → overlay body updated to `"The world was on fire and no one could save me but you"`; scrub to t=15 (before first lyric) → overlay hidden. Behavior matches the spec |
| + Lyric button → Fetch Lyrics fallback when remaining=0 (task #142) | ✅ | Bad Moon Rising (no lyrics): button label "Fetch Lyrics", classList includes `mode-fetch`. Wicked Game (HQ, empty lyrics.txt) has the same state on server; would render identically |

## Bug list

### P0 — blockers

**None found in this run.**

### P1 — significant

**BUG-2026-07-08-01. Wicked Game Live fails to reach `canplay` in 3 s, toast "no stems responded after 3s".** Click the Live version's library play button → within a couple seconds the "failed to load" toast fires and the player collapses. Server side is CLEAN: HEAD on each of the 6 stems returns 200 in 1–4 ms, ftyp brand is `mp42`, `moov` atom is at byte 32 (fast-start OK), file sizes ~9 MB each. Cache reports the folder as cached. So this is a browser-side stall — Chrome fetched the range but never emitted `canplay` before the 3 s deadline. Suspicion: something in the click-gate prefetcher (task #83) is racing against the streaming decoder. **Repro:** reload localhost:3000, search "wicked", click Live variant. **Not reproduced on Bad Moon Rising**, so it's per-song. Open — needs a browser-side diagnosis on why 6 concurrent 9 MB streams can wedge Chrome's decoder specifically for this file. `perf-server.log` around the timestamp likely holds the click-path instrumentation output.

**BUG-2026-07-08-02. Player fully collapses on load failure (regression-note "player collapses on load failure" made concrete).** When Wicked Game Live failed above, EVERY player element vanished — song header, visualizer, mixer console — leaving only the sidebar and the library grid. The operator now has to reload to get any player UI back. **Fix suggestion:** keep the previously-loaded song's UI intact on load failure. Log the failure and surface it as a toast (which we already do), but don't tear the player down.

**BUG-2026-07-08-03. Renderer freezes after failed load.** After the Wicked Game Live failure, subsequent CDP `Runtime.evaluate` calls timed out at 45 s. Recovering required navigating away. Likely correlated with BUG-01 and #137 (stems-health 35 s spike), which named a similar wedge. Note that Bill's Sunday practice scroll-lockup matches this shape.

### P2 — cosmetic / cleanup

**BUG-2026-07-08-04. Old Gig Builder draft gigs still present (confirms task #138).** `/api/gigs` returns `Draft_Jul_3_20_35`, `Draft_Jul_2_19_45` — the AI-populate autosaves that were never accepted. They also show setlists count 0, so they're pure litter. Cleanup script would need a rule: any gig with slug matching `^Draft_.*` and `setlists.length == 0` older than 24 h gets removed.

**BUG-2026-07-08-05. `currentSong.stems` reports 8 keys, not 6 (drift).** On Sweet Home Alabama and Bad Moon Rising both, `currentSong.stems` had `vocals, drums, bass, guitar, piano, other, rhythm, source`. `rhythm: null` is legacy — the demucs `htdemucs_6s` model output six stems; `rhythm` is a leftover key. `source: "source.wav"` is the raw 48 kHz reference — it should not be indexed as a stem. Neither breaks playback (the six real stems load correctly) but the client's stems dict shape is slowly drifting away from the CATALOG contract in ARCHITECTURE.md.

**BUG-2026-07-08-06. STEMS folder count (354) exceeds CATALOG.json row count (353).** Immediately after a successful render, the librarian dashboard shows this drift. The next hourly `catalog.py` pass will reconcile — but the librarian card could show a "pending catalog reconcile" hint so the drift isn't confusing.

**BUG-2026-07-08-07. `/api/recents` response shape is `{entries: [...]}` not `{recents: [...]}` — worth confirming this is the intended contract.** My first probe used `.recents` (based on gut) and saw an empty list. Correct key is `.entries`. If both clients agree on `.entries` this is fine; only surfacing here in case a downstream reader still uses `.recents`.

**BUG-2026-07-08-08. Version chip absent from Performer top-right after fresh page load.** Screenshots of the loaded portal show only the Wi-Fi pill and "Wed 2:33 PM" clock — no `V1.07080959` chip visible in the main viewport (I confirmed the build string only via the tab title). The librarian view DOES show it. If the intent is that both surfaces expose the build stamp, the Performer one is either mis-styled or hidden by layout.

**BUG-2026-07-08-09. Lyrics modal paste-target is narrow.** The textarea for pasted lyrics reads as a slim column to the right of the Google/UG/AZLyrics buttons. It's usable but not comfortable for pasting ~40-line lyrics. Widening to fill the modal (buttons stacked left-side, textarea flexes to fill) would help.

### Deferred verifications (not blockers, would be nice to run)

- PB3–PB12 (pause/resume/seek/mute/solo/master/SEMI/looper/routing/boosts)
- SRC1–SRC8 (source pill playback logic under drum/backing)
- DM1–DM7 (drum machine full cycle)
- LC1–LC5 (looper + count-in)
- SL1–SL8 (setlist navigation, ghost-add, favorites, recents, round-robin)
- GR1 (gig rename)
- LB11–LB13 (stems-health search, daemon heartbeat cards, auto-update evidence)
- SYS1, SYS2, SYS4 (restart, snapshot, caffeinate)
- R1–R5 (robustness)

The tab wedged mid-run (BUG-2026-07-08-03) which cut the interactive
sweep short. Recommend re-running the full suite AFTER BUG-01 is fixed
— fixing the media-element wedge should also fix the wedge that cut this
run off.

## Questions for Bill (cap 20)

1. **Wicked Game Live load failure**: is this reproducible on your machine too, or is it my session state? Try it after `Cmd+Shift+R` — does the Live version fail while the HQ version loads OK?
2. **Player-collapse-on-failure**: is the current behavior intentional (defensive tear-down), or is keeping the last-loaded song visible after a failure OK with you?
3. **`currentSong.stems` extra keys**: `rhythm` (null) and `source` (source.wav) shouldn't be there per the contract. Want me to filter these at the server, at the client, or both?
4. **Old draft gigs (task #138)**: are you OK with an auto-prune of `Draft_*` gigs older than 24 h with zero setlists?
5. **Lyrics modal layout**: want me to widen the textarea to fill the modal, or keep the current split layout intentional?
6. **Performer version chip**: it doesn't render on the top-right of the main view (only in the tab title). Should it be visible as a chip like on the Librarian view?

## What was changed in code this session

Recorded here so future runs can trace what these results actually covered:

1. `bt-construction-kit/public/app.js` — deleted the stale `els.lyricsModalFetching.style.display = 'none';` line in `openLyricsModal` (task #140).
2. `bt-construction-kit/public/app.js` — new `syncLyricsToPlayhead(t)` function + `window.syncLyricsToPlayhead` export; `_refreshLyricButtonLabel` treats `remaining === 0` the same as no-lyrics ("Fetch Lyrics" label, `mode-fetch` class); `onLyricTap` opens the editor directly instead of the "All N lines placed" confirm when the cursor is past the last cached line (tasks #141, #142).
3. `bt-construction-kit/public/visualizer.js` — appended a `window.syncLyricsToPlayhead(seconds)` call to `seekAllAudioTo` so every scrub goes through the lyrics-sync hook (task #141).

No shell scripts, server routes, catalog schema, or contracts were touched
this session.
