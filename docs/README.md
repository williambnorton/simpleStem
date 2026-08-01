# simpleStem documentation

The complete user documentation for simpleStem — the band's backing-track
system. Start with the Overview if you're new; jump straight to the Gig Day
Runbook if the van leaves in an hour.

## The suite

| Doc | What it covers |
|---|---|
| [01_OVERVIEW.md](01_OVERVIEW.md) | What simpleStem is, the two-machine architecture in plain words, and what each bandmate can do with it. |
| [02_GETTING_STARTED.md](02_GETTING_STARTED.md) | First launch on the Performer laptop, adding a song from YouTube, what happens during ingest, and playing your first song in each of the three playback modes. |
| [03_PLAYER_REFERENCE.md](03_PLAYER_REFERENCE.md) | Every control in the player, region by region — pills, visualizer, sections, action bar, transport, LOOPER, pitch knobs, the stem mixer console, and the XR18 banner buttons. |
| [04_GIGS_AND_SETLISTS.md](04_GIGS_AND_SETLISTS.md) | The Gig → Setlist → Song hierarchy, the gig picker and all nine pseudo-gigs, gig management, the Gig Builder, manual setlists, ghost-add, and auto-advance. |
| [05_LIBRARY.md](05_LIBRARY.md) | The library table column by column: stars, tags, singer pulldown, drum chip, the ⋯ action menu (re-fetch, Re-stem in Logic, delete), search syntax, sorting, grid view, and Library Analytics. |
| [06_KEYBOARD_SHORTCUTS.md](06_KEYBOARD_SHORTCUTS.md) | The complete shortcut cheat sheet, organized by category, plus the meta combos and Keyboard Maestro notes. Press `?` in the portal for the live version. |
| [07_LIBRARIAN.md](07_LIBRARIAN.md) | The Mac mini's role, a tour of the `/librarian` dashboard (Living Pipeline, health table, daemons), auto-update behavior, and `librarian.sh` commands. |
| [08_GIG_DAY_RUNBOOK.md](08_GIG_DAY_RUNBOOK.md) | The pre-gig checklist (Flash Cache, offline test, XR18 hookup, sound check), during-gig operations, and the audio failure first-aid ladder. |
| [09_TROUBLESHOOTING.md](09_TROUBLESHOOTING.md) | Symptom-indexed fixes: songs that won't load, the SERVER NOT RESPONDING banner, missing stems, failed renders, Drive sync friction, and the two-machine git rules. |
- **10_AUDIO_WEDGE_DEEP_DIVE.md** — cited research report on the CoreAudio/XR18 USB wedge: failure chain, recovery ladder, ranked fixes.
- **11_LOOP_OVERDUB.md** — the overdub looper: rig setup (BlackHole/Logic LOOP bus), take workflow, latency trim, session storage.

Screenshots referenced throughout live in [`images/`](images/) and are being
added incrementally; a `SCREENSHOT:` caption marks each planned image.

For developers and forkers, see [../ARCHITECTURE.md](../ARCHITECTURE.md).
For the AI coding agent's rules, see [../CLAUDE.md](../CLAUDE.md).

## Reference diagrams

The [`diagrams/`](diagrams/) folder holds hand-authored SVG workflow diagrams.
Open each SVG directly in a browser for full resolution; they zoom cleanly to
any size.

| File | Purpose |
|---|---|
| [01_song_ingest.svg](diagrams/01_song_ingest.svg) | Three user paths (Chrome Quick Action, portal paste, manual drop) → `INCOMING_WEBLOC` → watcher → queue → render → `STEMS/`. |
| [02_live_performance.svg](diagrams/02_live_performance.svg) | Picking a gig → loading a song → Web Audio + MIDI graph during playback. Every file the portal reads + writes per song. |
| [03_xr18_recovery.svg](diagrams/03_xr18_recovery.svg) | The recovery ladder when the XR18 goes silent. Top-to-bottom, parallel diagnostics on the right, symptom decoder bottom-right. |
| [04_architecture.svg](diagrams/04_architecture.svg) | Performer + Librarian + GitHub + Drive + hardware. Who owns what, who pushes vs. pulls, where the `.git` lives. |

When editing the diagrams: the SVGs are plain text — open in any editor. The
visual palette stays consistent across all four: navy for user actions, slate
for scripts, amber for transient queues, green for storage, pink for hardware.
Keep that.

## Shared vocabulary

When pointing at UI elements in conversation, use the names defined in
[03_PLAYER_REFERENCE.md](03_PLAYER_REFERENCE.md) — brand chip, gig sidebar,
gig picker, library row, meta pills row, visualizer, action bar, transport
row, LOOPER card, pitch knobs, Stem Mixer Console, mixer header, XR18 state
badge. The player reference names every one of them by its on-screen label.

## 12-18 (added later; this index had lapsed)

| Doc | Covers |
|---|---|
| `12_CLICK_TRACK.md` | click regions, the beat grid, count-in |
| `13_SOUND_DESKTOP.md` | the desk: objects, wires, right-click methods |
| `14_XR18_CONTROL.md` | XR18 over OSC — address space, the dB curve, amp programs, preflight |
| `15_DESK_METHOD_TEST_PLAN.md` | every desk/console method, its wire-log signature and safety class |
| `16_SYSTEM_ARCHITECTURE.md` | the two-machine picture |
| `17_EAVFA_OBJECT_MODEL.md` | object model |
| `18_MPL_LANGUAGE.md` | MPL syntax, EBNF, semantics |
