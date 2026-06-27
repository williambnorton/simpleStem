# simpleStem — Reference Diagrams + UI Vocabulary

This folder is the visual companion to `CLAUDE.md`. When you describe a problem
("the orphan badge is amber, not red") or a workflow ("why did the Quick Action
not land in STEM_QUEUE?"), point at one of these instead of writing a paragraph.

## Workflow diagrams

Open each SVG directly in a browser for full resolution; they're hand-authored
so they zoom cleanly to any size.

| File | Purpose |
|---|---|
| [01_song_ingest.svg](diagrams/01_song_ingest.svg) | Three user paths (Chrome Quick Action, portal paste, manual drop) → `INCOMING_WEBLOC` → watcher → queue → render → `STEMS/` + `M4A/`. |
| [02_live_performance.svg](diagrams/02_live_performance.svg) | Picking a gig → loading a song → Web Audio + MIDI graph during playback. Every file the portal reads + writes per song. |
| [03_xr18_recovery.svg](diagrams/03_xr18_recovery.svg) | The recovery ladder when XR18 goes silent. Top-to-bottom, parallel diagnostics on the right, symptom decoder bottom-right. |
| [04_architecture.svg](diagrams/04_architecture.svg) | Performer + Librarian + GitHub + Drive + hardware. Who owns what, who pushes vs. pulls, where the .git lives. |

## UI vocabulary (TODO — needs a screenshot capture round)

When we point at UI elements in conversation, we want to use the same names.
The annotated screenshot will live at `docs/ui_anatomy.png` and label every
clickable region by name. Until that exists, this list is the names to use:

- **brand chip** — top-left "simpleStem V1.MMDDHHMM" pill.
- **gig sidebar** — left column listing gigs and setlists.
- **gig picker** — drop-down at top of the sidebar; includes pseudo-gigs
  (Recents, Favorites, singer-filtered, Round Robin, YouTube Sync, Manual Setlists).
- **search box / Paste URL box** — top of the sidebar.
- **library row** — one song in the right-pane song list. Columns:
  Set / Title (with ☆ star) / Artist / Duration / Tempo / Key / Singer (pulldown) / ⋯ action menu.
- **track badge row** — the row above the visualizer showing BPM / Key / Drum / Time.
- **visualizer** — the waveform + section bands + automation lane in the upper-right.
- **transport row** — Prev / Stop / Play / FF / Next / Loop / Tempo controls.
- **section keys** — `1`–`9` drop section markers at the playhead.
- **LOOPER panel** — large rectangle at right, mid-row. Has Click and Count-in beside it.
- **PITCH knobs** — SEMI (quantized ±3 in 0.5 steps) and CENT (±50 in 1-cent steps).
- **Stem Mixer Console** — six channel strips in the lower half. Each strip:
  - **boost buttons** — `+5` `D` `+10` flanking the routing center button.
  - **routing buttons** — `L` `R` `V` `D` `B` `G` `P` `O` per strip (V/D/B/G/P/O = home channels 11–16).
  - **fader** — vertical level slider.
  - **M / S** — mute and solo.
  - **channel grid** — small row of `3 4 5 6 7 8 9 10 17 18` for the non-named outputs.
- **mixer header** — strip across the top of the Stem Mixer Console. From left:
  - `Stem Mixer Console` label
  - **XR18 state badge** — `● XR18 ACTIVE · 18 ch out` (green), `XR18 connected but NOT default output` (amber), `⚠ XR18 ORPHANED · …` (red pulsing).
  - **→ XR18 pill** — switch macOS default output to XR18 + reload (no matrix change).
  - **→ Sys Out pill** — switch macOS default output to MacBook Pro Speakers + reload.
  - **📋 snapshot** — append current state to `~/.simpleStem-catalog/debug-snapshots.log`.
  - **🔔 bell** — run the round-the-horn 8-step Sound Check (Left, Right, One–Six).
  - **🔄 restart** — `performer.sh restart`.
  - **🩹 first aid** — `sudo killall coreaudiod` (use AFTER USB replug, never before).
- **action bar** — buttons above the visualizer: `+ CLIP`, `+ ACTION`, `FETCH LYRICS` / `+ LYRIC`, `HIDE LYRICS` / `SHOW LYRICS`, `INIT`, `ACCEPT`, `NEXT ▶`, `SAVE`, `CLEAR`, action count.

## Operational guides

- **Bring the Librarian up to current code:** `git pull` in `~/simpleStem-code`,
  then `./sync_to_drive.sh` (NOT `git pull` in `~/ClaudeDrive/simpleStem` — the
  Drive `.git` is no longer maintained). Then `./librarian.sh restart`.
- **Bring the Performer up to current code:** same. The
  `~/ClaudeDrive/simpleStem` clone is no longer used as a git working tree.
- **Add a song:** Chrome Quick Action (right-click any YouTube URL → Services →
  Send to simpleStem) OR paste URL in the portal sidebar OR drop a .webloc
  into `INCOMING_WEBLOC/`. All three paths converge — see diagram 1.
- **Recover XR18 silence:** see diagram 3.

## Editing these diagrams

The SVGs are plain text — open in any editor. The visual palette stays
consistent across all four: navy for user actions, slate for scripts, amber
for transient queues, green for storage, pink for hardware. Keep that.
